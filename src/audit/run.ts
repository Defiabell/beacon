import type { Env } from "../types";
import type { ProjectConfig } from "../config";
import type { FetchFn } from "../collect/github";
import { ghHeaders } from "../collect/github";
import { CONFIG } from "../config";
import { upsertAuditResults, insertTodoIfNew, closeTodoByTitle } from "../db";
import type { RepoAuditInput } from "./checks";
import { runRepoChecks, todoTitle } from "./checks";

const USER_AGENT = "beacon (+https://github.com/Defiabell/beacon)";
// Per-repo external-link check budget. Chosen so a full audit run of 4 repos
// worst-cases at 4 base fetches + 3 links x2 (HEAD, then a GET fallback on
// 403/405) per repo = 4x(4+3x2) = 40 subrequests — comfortably under the
// Workers free tier's 50-subrequests-per-invocation cap. See wrangler.toml /
// src/collect/run.ts for how the daily cron is split across two invocations
// so this budget doesn't also have to share headroom with github/posts/
// goatcounter in the same invocation.
const MAX_LINKS_CHECKED = 3;
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

function extractReadmeLinks(readme: string): string[] {
  const matches = (readme.match(/https?:\/\/[^\s)"'<>]+/g) ?? [])
    .map(trimUrlTail)
    .filter(u => /^https?:\/\/[^/]+/.test(u));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of matches) {
    if (seen.has(url)) continue;
    seen.add(url);
    if (isGithubHosted(url)) continue;
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
    if (res.status === 405 || res.status === 403) {
      res = await fetchFn(url, { method: "GET" });
    }
    return res.status >= 400;
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
  const [meta, readme, releaseAssetCount, ogImageUrl] = await Promise.all([
    fetchRepoMeta(token, project.repo, fetchFn),
    fetchReadme(token, project.repo, fetchFn),
    fetchReleaseAssetCount(token, project.repo, fetchFn),
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
