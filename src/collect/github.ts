import type { RepoDaily, ReferrerRow } from "../types";

export type FetchFn = typeof fetch;

export function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "beacon (+https://github.com/Defiabell/beacon)"
  };
}

async function ghJson<T>(token: string, path: string, fetchFn: FetchFn, accept?: string): Promise<T> {
  const res = await fetchFn(`https://api.github.com${path}`, {
    headers: { ...ghHeaders(token), ...(accept ? { Accept: accept } : {}) }
  });
  if (!res.ok) throw new Error(`github ${path} -> ${res.status}`);
  return res.json();
}

function hasNextLink(linkHeader: string | null): boolean {
  if (!linkHeader) return false;
  return linkHeader.split(",").some(part => /rel="next"/.test(part));
}

// GitHub caps this endpoint around 40,000 stargazers (400 pages at per_page=100);
// this bound is a defensive backstop against a malformed/self-referential Link
// header driving an infinite pagination loop, not an expected real limit.
const MAX_STARGAZER_PAGES = 500;

export async function backfillStarHistory(token: string, repo: string, fetchFn: FetchFn = fetch): Promise<{ date: string; stars: number }[]> {
  const counts = new Map<string, number>();
  let page = 1;
  for (;;) {
    if (page > MAX_STARGAZER_PAGES) throw new Error(`github /repos/${repo}/stargazers -> exceeded ${MAX_STARGAZER_PAGES} pages`);
    const res = await fetchFn(`https://api.github.com/repos/${repo}/stargazers?per_page=100&page=${page}`, {
      headers: { ...ghHeaders(token), Accept: "application/vnd.github.star+json" }
    });
    if (!res.ok) throw new Error(`github /repos/${repo}/stargazers -> ${res.status}`);
    const items: { starred_at: string }[] = await res.json();
    for (const item of items) {
      const date = item.starred_at.slice(0, 10);
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    if (!hasNextLink(res.headers.get("Link"))) break;
    page++;
  }
  const dates = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  let cumulative = 0;
  return dates.map(date => {
    cumulative += counts.get(date)!;
    return { date, stars: cumulative };
  });
}

interface DayStat { timestamp: string; count: number; uniques: number; }

export interface RepoTraffic { daily: RepoDaily[]; referrers: ReferrerRow[]; }

export async function fetchRepoTraffic(token: string, repo: string, fetchFn: FetchFn = fetch): Promise<RepoTraffic> {
  const [views, clones, referrers, meta] = await Promise.all([
    ghJson<{ views: DayStat[] }>(token, `/repos/${repo}/traffic/views`, fetchFn),
    ghJson<{ clones: DayStat[] }>(token, `/repos/${repo}/traffic/clones`, fetchFn),
    ghJson<{ referrer: string; count: number; uniques: number }[]>(token, `/repos/${repo}/traffic/popular/referrers`, fetchFn),
    ghJson<{ stargazers_count: number; forks_count: number }>(token, `/repos/${repo}`, fetchFn)
  ]);
  const byDate = new Map<string, RepoDaily>();
  const day = (ts: string) => ts.slice(0, 10);
  const get = (date: string): RepoDaily => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        repo,
        date,
        views: 0,
        uniqueViews: 0,
        clones: 0,
        uniqueClones: 0,
        stars: meta.stargazers_count,
        forks: meta.forks_count
      });
    }
    return byDate.get(date)!;
  };
  for (const v of views.views) Object.assign(get(day(v.timestamp)), { views: v.count, uniqueViews: v.uniques });
  for (const c of clones.clones) Object.assign(get(day(c.timestamp)), { clones: c.count, uniqueClones: c.uniques });
  return {
    daily: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    referrers: referrers.map(r => ({ referrer: r.referrer, count: r.count, uniques: r.uniques }))
  };
}
