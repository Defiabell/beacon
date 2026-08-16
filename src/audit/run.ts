import type { Env } from "../types";
import type { ProjectConfig } from "../config";
import type { FetchFn } from "../collect/github";
import { ghHeaders } from "../collect/github";
import { CONFIG } from "../config";
import { upsertAuditResults, insertTodoIfNew, reopenTodoByTitle, closeTodoByTitle } from "../db";
import type { RepoAuditInput } from "./checks";
import { runRepoChecks, todoTitle } from "./checks";

const USER_AGENT = "beacon (+https://github.com/Defiabell/beacon)";

// A HEAD answered with one of these means "this server won't tell me about the
// resource this way", not "the resource is gone" — retry with GET before
// concluding anything. See isLinkBroken.
const HEAD_UNSUPPORTED_STATUSES = new Set([403, 404, 405, 410]);

// Per-repo external-link check budget. See auditWorstCaseSubrequests below for
// the arithmetic this has to satisfy — the test suite asserts the current
// CONFIG.projects fleet stays under the cap, so growing the fleet fails a test
// locally instead of silently blowing the audit's subrequest budget in
// production. See wrangler.toml / src/collect/run.ts for how the daily cron is
// split across two invocations so this budget doesn't also have to share
// headroom with github/posts/goatcounter in the same invocation.
const MAX_LINKS_CHECKED = 3;

// Base (non-link) fetches per repo: repo meta, README, og:image — plus the
// releases call, which collectAuditInput skips for a project that isn't macos-
// tagged (checkReleaseAssets in ../audit/checks.ts returns "na" without ever
// reading releaseAssetCount there, so fetching it was pure waste).
const AUDIT_BASE_FETCHES = 3;

// The Workers free tier caps an invocation at 50 subrequests (Cloudflare's
// documented limit). Overrunning it fails the offending fetch rather than
// returning a partial result, and runSource (src/collect/run.ts) turns that
// into the whole audit source recording ok:false — a failure nobody sees until
// they look at /api/health. The exact overrun semantics are not something this
// project has observed in production; the ceiling is asserted precisely so it
// stays that way.
export const SUBREQUEST_CAP = 50;

// Worst case for one audit invocation over `projects`: every repo pays its base
// fetches, plus every checked link costs 2 (HEAD, then the GET fallback). When
// this outgrows SUBREQUEST_CAP the fix is to shard the audit across more cron
// invocations (wrangler.toml), not to keep shaving MAX_LINKS_CHECKED — see
// https://github.com/Defiabell/beacon/issues/12.
export function auditWorstCaseSubrequests(projects: ProjectConfig[]): number {
  return projects.reduce(
    (sum, p) => sum + AUDIT_BASE_FETCHES + (p.tags.includes("macos") ? 1 : 0) + MAX_LINKS_CHECKED * 2,
    0
  );
}
const SOCIAL_PREVIEW_URL = (repo: string) => `https://github.com/${repo}`;

interface RepoMeta {
  description: string | null;
  topics: string[];
  homepage: string | null;
  license: { key: string } | null;
}

async function fetchRepoMeta(token: string, repo: string, fetchFn: FetchFn): Promise<RepoMeta> {
  const res = await fetchFn(`https://api.github.com/repos/${repo}`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`github /repos/${repo} -> ${res.status}`);
  const json = await res.json<{
    description: string | null;
    topics?: string[];
    homepage: string | null;
    license: { key: string } | null;
  }>();
  return {
    description: json.description,
    topics: json.topics ?? [],
    homepage: json.homepage,
    license: json.license
  };
}

// GitHub returns 404 for repos with no README committed; that's a legitimate
// "no readme" state (not a fetch failure), so it maps to an empty string
// rather than throwing. Any other non-2xx is a real failure and propagates.
async function fetchReadme(token: string, repo: string, fetchFn: FetchFn): Promise<string> {
  const res = await fetchFn(`https://api.github.com/repos/${repo}/readme`, {
    headers: { ...ghHeaders(token), Accept: "application/vnd.github.raw+json" }
  });
  if (res.status === 404) return "";
  if (!res.ok) throw new Error(`github /repos/${repo}/readme -> ${res.status}`);
  return res.text();
}

async function fetchReleaseAssetCount(token: string, repo: string, fetchFn: FetchFn): Promise<number> {
  const res = await fetchFn(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
    headers: ghHeaders(token)
  });
  if (!res.ok) throw new Error(`github /repos/${repo}/releases -> ${res.status}`);
  const releases = await res.json<{ assets?: unknown[] }[]>();
  return releases.reduce((sum, r) => sum + (r.assets?.length ?? 0), 0);
}

// Screen-scrapes the repo's public GitHub page for its og:image meta tag. This
// is not an official API (no auth, no contract), so any hiccup — non-2xx or a
// network error — is treated as "no custom social preview" rather than a fatal
// error: it would otherwise abort the whole project's audit over a cosmetic,
// best-effort signal.
async function fetchOgImage(repo: string, fetchFn: FetchFn): Promise<string | null> {
  let html: string;
  try {
    const res = await fetchFn(SOCIAL_PREVIEW_URL(repo), { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }
  const match = html.match(/<meta property="og:image" content="([^"]+)"/);
  return match ? match[1] : null;
}

// READMEs document deploy targets as templates — "https://shotsync.<subdomain>
// .workers.dev". The URL match stops at "<", leaving a TLD-less fragment like
// "https://shotsync" that resolves nowhere and would be reported broken forever.
// A hostname with no dot is never a real external link (this also drops
// localhost and intranet names, which are not ours to check either).
function isCheckableHost(url: string): boolean {
  try {
    return new URL(url).hostname.includes(".");
  } catch {
    return false;
  }
}

// A *.workers.dev address cannot be checked from inside a Worker, so beacon
// must not render a verdict on one. Measured 2026-08-17 with a throwaway Worker
// deployed to the same account: GET https://shotsync-demo.defiabell.workers.dev
// and GET https://screen-coach-trial.defiabell.workers.dev both answer 404 from
// Workers egress, while the same GETs answer 200 from an ordinary client, and
// control fetches to shiling.pages.dev and example.com answer 200 from both.
// The audit had been reporting both of those live demos as broken README links.
//
// What was NOT established, and is not planned to be: whether this is specific
// to the *same* account's workers.dev subdomain or applies to any of them. The
// skip is deliberately broad either way — a missed check is recoverable, a false
// "broken link" mints a P1 todo the owner then chases for nothing, which has now
// happened five separate ways.
//
// Skipped silently, rather than reported as a third "unverifiable" outcome,
// because CheckResult.status (../audit/checks.ts) is a closed pass/fail/na union
// that the D1 schema and every rendering site agree on; widening it for a
// handful of the owner's own demo links isn't worth the ripple. If this list
// ever grows enough to need visibility, checkReadmeLinks's freeform `detail`
// string is the cheap place to say "N links skipped as unverifiable".
//
// Exact-or-subdomain match, and an unparsable URL is NOT skipped — same shape as
// isGithubHosted below, deliberately, so that "evil-workers.dev" and
// "workers.dev.attacker.com" both stay checked.
function isWorkersDevHosted(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "workers.dev" || hostname.endsWith(".workers.dev");
  } catch {
    return false;
  }
}

function isGithubHosted(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    // Exact-or-subdomain match (not a bare suffix check) so lookalikes like
    // "evilgithub.com" or "fakegithub.com" aren't mistaken for github.com and
    // skipped from the broken-link check.
    return hostname === "github.com" || hostname.endsWith(".github.com");
  } catch {
    return true; // unparsable URL: skip it rather than risk hammering an arbitrary host
  }
}

// The github.com exemption is applied here, before the MAX_LINKS_CHECKED
// truncation — not after. READMEs commonly front-load github.com
// self-references (badges, Actions/Issues links), and those never need
// checking; counting them against the link-check budget (MAX_LINKS_CHECKED) would silently push
// real external links out of the check entirely on a link-heavy README.
// A bare URL in markdown often butts up against emphasis or sentence
// punctuation — "**play: https://example.com/**", "see https://example.com/x."
// — and those characters belong to the prose, not the link. Left attached they
// turn a working page into a phantom broken link, and every audit run mints a
// P1 todo for it. A trailing slash is kept: that one really is part of the URL.
function trimUrlTail(url: string): string {
  return url.replace(/[*_~`.,;:!?\]}]+$/, "");
}

// A URL inside a fenced block or a code span is a value being displayed — a
// curl example, a base_url setting — not a link anyone can follow, and its
// status says nothing about the README's quality. (screen-coach documents
// `base_url="https://api.anthropic.com"`; that root answers 404 because the API
// lives at /v1/messages, which made the check right and its conclusion wrong.)
function stripCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

// Full-width CJK punctuation terminates a bare URL exactly the way whitespace
// and ")" already did. These READMEs are Chinese, so a link is routinely
// followed immediately by 「（」or「，」with no space — shiling's README carries
// "https://shiling.pages.dev**（无需安装，存档在浏览器本地）", which the ASCII-only
// stop set swallowed whole, producing the un-resolvable phantom URL
// "https://shiling.pages.dev**（无需安装，存档在浏览器本地）" and a P1 todo for a
// link that works. Deliberately a fixed punctuation list rather than "any
// non-ASCII": an internationalized domain is a real URL and must keep matching.
const CJK_URL_TERMINATORS = "（）【】〔〕「」『』〈〉《》，。、；：！？…—～·“”‘’\\u3000";
const BARE_URL = new RegExp(`https?://[^\\s)"'<>${CJK_URL_TERMINATORS}]+`, "g");

function extractReadmeLinks(readme: string): string[] {
  const matches = (stripCode(readme).match(BARE_URL) ?? [])
    .map(trimUrlTail)
    .filter(u => /^https?:\/\/[^/]+/.test(u));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of matches) {
    if (seen.has(url)) continue;
    seen.add(url);
    if (!isCheckableHost(url)) continue;
    if (isGithubHosted(url)) continue;
    if (isWorkersDevHosted(url)) continue;
    result.push(url);
    if (result.length >= MAX_LINKS_CHECKED) break;
  }
  return result;
}

// Individual link-check network errors count as broken (can't confirm the link
// works), but they don't abort the whole audit — only the total README fetch
// failure upstream does that.
async function isLinkBroken(url: string, fetchFn: FetchFn): Promise<boolean> {
  try {
    let res = await fetchFn(url, { method: "HEAD" });
    // 404 and 410 are in this fallback list, not just 403/405, because plenty
    // of hand-rolled routers answer an unhandled HEAD with a plain 404 instead
    // of 405 — beacon's own router does exactly that (src/index.ts's routePage
    // returns null for a non-GET, which falls through to notFound()), and so
    // does shotsync's demo Worker, which this audit consequently reported as a
    // broken README link for days while the URL answered 200 to a GET. Treating
    // a HEAD 404 as final made "server doesn't implement HEAD" indistinguishable
    // from "page is gone". The worst case is unchanged at 2 fetches per link:
    // the statuses were already a fallback trigger, this only widens which ones.
    if (HEAD_UNSUPPORTED_STATUSES.has(res.status)) {
      res = await fetchFn(url, { method: "GET" });
    }
    // Only "this address leads nowhere" counts. A README that cites an API root
    // (https://api.anthropic.com answers 401 unauthenticated) or a page behind a
    // login is not carrying a broken link, and a 5xx is the far end having a bad
    // day rather than the link being wrong — see #11 on retrying those. Every
    // false positive here becomes a P1 todo, so the bar is deliberately narrow.
    return res.status === 404 || res.status === 410;
  } catch {
    return true;
  }
}

async function findBrokenLinks(readme: string, fetchFn: FetchFn): Promise<string[]> {
  const links = extractReadmeLinks(readme);
  const checked = await Promise.all(links.map(async url => ({ url, broken: await isLinkBroken(url, fetchFn) })));
  return checked.filter(c => c.broken).map(c => c.url);
}

export async function collectAuditInput(
  token: string,
  project: ProjectConfig,
  fetchFn: FetchFn = fetch
): Promise<RepoAuditInput> {
  // The releases call is skipped entirely for a non-macos project:
  // checkReleaseAssets (../audit/checks.ts) short-circuits to "na" on the same
  // condition without reading releaseAssetCount, so fetching it bought nothing
  // and spent one of the invocation's 50 subrequests. 0 is the value that check
  // never looks at — deliberately not a null/undefined sentinel, which would
  // only invite a "no releases data" branch that has no meaning here.
  const needsReleases = project.tags.includes("macos");
  const [meta, readme, releaseAssetCount, ogImageUrl] = await Promise.all([
    fetchRepoMeta(token, project.repo, fetchFn),
    fetchReadme(token, project.repo, fetchFn),
    needsReleases ? fetchReleaseAssetCount(token, project.repo, fetchFn) : Promise.resolve(0),
    fetchOgImage(project.repo, fetchFn)
  ]);
  const brokenLinks = await findBrokenLinks(readme, fetchFn);
  return {
    project: project.name,
    tags: project.tags,
    configHomepage: project.homepage ?? null,
    meta,
    readme,
    releaseAssetCount,
    ogImageUrl,
    brokenLinks
  };
}

// Per-project isolation mirrors collectGithub (src/collect/run.ts): one repo's
// fetch failure shouldn't stop the rest of the fleet from being checked. Since
// this function's signature is void, an overall failure surfaces by throwing
// an aggregated error after the loop — the orchestrator's per-source try/catch
// (runSource in src/collect/run.ts) turns that into ok:false with the message.
export async function runAudit(env: Env, fetchFn: FetchFn = fetch): Promise<void> {
  const checkedAt = new Date().toISOString();
  const failures: string[] = [];
  for (const project of CONFIG.projects) {
    try {
      const input = await collectAuditInput(env.GITHUB_TOKEN, project, fetchFn);
      const results = runRepoChecks(input);
      await upsertAuditResults(env.DB, project.name, results, checkedAt);
      for (const result of results) {
        const title = todoTitle(result.checkId, input);
        if (result.status === "fail") {
          await insertTodoIfNew(env.DB, {
            project: project.name,
            source: "audit",
            title,
            priority: result.priority,
            status: "open"
          });
          // insertTodoIfNew is a no-op when a row with this title already
          // exists — including one that was closed on an earlier run — so a
          // regressed check needs this second call to bring the todo back.
          // Together the pair is "make sure an open todo exists for this
          // failing check", which is the actual invariant.
          await reopenTodoByTitle(env.DB, project.name, "audit", title);
        } else if (result.status === "pass") {
          // The check that generated this todo (if any) now passes — close it.
          // Safe to call unconditionally: it's a no-op UPDATE when no open todo
          // with this exact title exists. Relies on todoTitle being STABLE per
          // (project, checkId) regardless of check-specific detail (e.g.
          // readme-links no longer embeds the broken-link list in the title) —
          // otherwise this title wouldn't match the row insertTodoIfNew created
          // on an earlier failing run with a different detail.
          await closeTodoByTitle(env.DB, project.name, "audit", title, checkedAt);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${project.repo}: ${msg}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}
