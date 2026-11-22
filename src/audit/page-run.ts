import type { Env } from "../types";
import type { BeaconConfig } from "../config";
import type { FetchFn } from "../collect/github";
import { CONFIG } from "../config";
import { SEO_MINUTES } from "../schedule";
import { SUBREQUEST_CAP, applyAuditResults, sitemapUrlFor, shardByCost } from "./run";
import type { FetchedResource, PageAuditInput, PageTarget } from "./page-checks";
import { pageTodoTitle, parsePage, runPageChecks } from "./page-checks";

const USER_AGENT = "beacon (+https://github.com/Defiabell/beacon)";

// Fetches per audited page: the page itself and robots.txt (its Sitemap: line
// names the sitemap), then the sitemap and the og:image. One GET each — the
// image too, because a HEAD that a static host answers 404/405 would need the
// same GET fallback the README link check has, and the GET's headers are all
// the check reads (the body is cancelled).
export const PAGE_AUDIT_FETCHES = 4;

// fetch() follows redirects, and every hop is a subrequest of its own against
// the same per-invocation cap. None of the audited pages, robots files or
// sitemaps redirected when this was written (2026-11-22, all 21 sites), but a
// site that adds a trailing-slash or http->https hop must not be able to push
// the rest of its shard over the cap, so each page carries two hops of slack.
export const REDIRECT_ALLOWANCE = 2;

export function pageTargetCost(t: PageTarget): number {
  return t.exception.notASite ? 0 : PAGE_AUDIT_FETCHES + REDIRECT_ALLOWANCE;
}

// hostname, plus the path for a homepage that lives under one: the two GitHub
// Pages projects share defiabell.github.io and are different pages.
function pageKey(u: URL): string {
  return u.hostname.toLowerCase() + u.pathname.replace(/\/+$/, "");
}

// Every page the audit looks at: each host a zone-level site declares (the
// defiabell.com subdomains — most are private-repo sites that the repo audit
// never sees), then each project homepage not already covered. Derived from
// the config rather than listed, so a new subdomain or project is audited the
// day it is added. Deterministic order, so shards are stable from day to day.
//
// The pre-zone *.pages.dev / *.workers.dev / github.io site entries are not
// included as hosts: those addresses are kept reachable on purpose as aliases
// of the defiabell.com ones, and their pages correctly canonicalise away from
// themselves. *.workers.dev is unreachable from inside a Worker anyway (see
// isWorkersDevHosted in ./run.ts).
export function pageAuditTargets(config: BeaconConfig = CONFIG): PageTarget[] {
  const urls: string[] = [];
  for (const site of config.sites) for (const host of site.hosts ?? []) urls.push(`https://${host}/`);
  for (const p of config.projects) if (p.homepage) urls.push(p.homepage);
  const seen = new Set<string>();
  const targets: PageTarget[] = [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    if (!host.includes(".") || host === "workers.dev" || host.endsWith(".workers.dev")) continue;
    const key = pageKey(u);
    if (seen.has(key)) continue;
    seen.add(key);
    const exception = config.pageAudit[key] ?? {};
    targets.push({ key, url: u.href, expectedHost: (exception.canonicalHost ?? host).toLowerCase(), exception });
  }
  return targets;
}

export function pageAuditShards(targets: PageTarget[] = pageAuditTargets(), cap: number = SUBREQUEST_CAP): PageTarget[][] {
  return shardByCost(targets, pageTargetCost, t => `page ${t.key}`, cap);
}

// One GET. A transport failure becomes status null ("could not look"), which
// the checks turn into n/a rather than a todo. `read` keeps the body as text;
// otherwise it is cancelled so an image download does not hold the invocation.
async function fetchResource(url: string, fetchFn: FetchFn, read: boolean, accept: string): Promise<FetchedResource> {
  try {
    const res = await fetchFn(url, { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: accept } });
    const resource: FetchedResource = { url, status: res.status, contentType: res.headers.get("content-type") };
    if (read) resource.body = await res.text();
    else await res.body?.cancel();
    return resource;
  } catch (e) {
    return { url, status: null, contentType: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function isOk(r: FetchedResource): boolean {
  return r.status !== null && r.status >= 200 && r.status < 300;
}

// Exactly PAGE_AUDIT_FETCHES calls through fetchFn at most (fewer when there is
// no og:image to fetch): page + robots.txt in parallel, then sitemap + image.
export async function collectPageAuditInput(target: PageTarget, fetchFn: FetchFn = fetch): Promise<PageAuditInput> {
  if (target.exception.notASite) return { target, page: null, sitemap: null, ogImage: null };
  const origin = new URL(target.url).origin;
  const [page, robots] = await Promise.all([
    fetchResource(target.url, fetchFn, true, "text/html,application/xhtml+xml"),
    fetchResource(`${origin}/robots.txt`, fetchFn, true, "text/plain, */*")
  ]);
  // A robots.txt that is really the SPA's index page has no Sitemap: line to
  // trust; fall back to /sitemap.xml like a crawler would.
  const declared =
    isOk(robots) && !(robots.contentType ?? "").includes("text/html")
      ? (robots.body ?? "").match(/^\s*sitemap\s*:\s*(\S+)/im)?.[1] ?? null
      : null;
  const pageHtml = isOk(page) && (page.contentType ?? "").toLowerCase().includes("text/html");
  const og = pageHtml ? parsePage(page.body ?? "").ogImage : null;
  const [sitemap, ogImage] = await Promise.all([
    fetchResource(sitemapUrlFor(origin, declared), fetchFn, true, "application/xml, text/xml, */*"),
    og && /^https?:\/\//i.test(og) ? fetchResource(og, fetchFn, false, "image/*") : Promise.resolve(null)
  ]);
  return { target, page, sitemap, ogImage };
}

// Same shape as runAudit (./run.ts): one shard per invocation, each page
// isolated so one failure does not stop the rest, results and todos filed
// under the page key.
export async function runPageAudit(env: Env, fetchFn: FetchFn = fetch, shardIndex = 0): Promise<void> {
  const shards = pageAuditShards();
  if (shards.length > SEO_MINUTES.length) {
    throw new Error(
      `page audit needs ${shards.length} shards but only ${SEO_MINUTES.length} seo minute slot(s) are configured; ` +
        `add one to src/schedule.ts AND wrangler.toml`
    );
  }
  const targets = shards[shardIndex] ?? [];
  const checkedAt = new Date().toISOString();
  const failures: string[] = [];
  for (const target of targets) {
    try {
      const input = await collectPageAuditInput(target, fetchFn);
      await applyAuditResults(env.DB, target.key, runPageChecks(input), checkId => pageTodoTitle(checkId, target.key), checkedAt);
    } catch (e) {
      failures.push(`${target.key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}
