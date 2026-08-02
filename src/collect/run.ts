import type { Env, Post } from "../types";
import type { FetchFn } from "./github";
import { fetchRepoTraffic } from "./github";
import { fetchPostMetrics } from "./posts";
import { fetchSiteDaily } from "./goatcounter";
import { CONFIG } from "../config";
import {
  upsertRepoDaily,
  replaceReferrerSnapshot,
  upsertStarHistory,
  listPosts,
  upsertPostMetrics,
  upsertSiteDaily,
  recordSourceRun
} from "../db";

export interface CollectorReport {
  source: string;
  ok: boolean;
  error?: string;
}

interface SourceResult {
  ok: boolean;
  error?: string;
}

async function runSource(db: D1Database, source: string, fn: () => Promise<SourceResult>): Promise<CollectorReport> {
  let result: SourceResult;
  try {
    result = await fn();
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await recordSourceRun(db, source, result.ok, result.error);
  return result.error !== undefined
    ? { source, ok: result.ok, error: result.error }
    : { source, ok: result.ok };
}

async function collectGithub(env: Env, date: string, fetchFn: FetchFn): Promise<SourceResult> {
  for (const project of CONFIG.projects) {
    const traffic = await fetchRepoTraffic(env.GITHUB_TOKEN, project.repo, fetchFn);
    await upsertRepoDaily(env.DB, traffic.daily);
    await replaceReferrerSnapshot(env.DB, project.repo, date, traffic.referrers);
    // Every row in `traffic.daily` carries the same (current) stargazers_count,
    // fetched once from the repo-meta call inside fetchRepoTraffic — so any
    // element gives us "today's" star tally. When there's no traffic data at
    // all (no views/clones in the response window), there's nothing to read
    // the count off of, so we simply skip the star_history write for this repo.
    const starsToday = traffic.daily.length > 0 ? traffic.daily[traffic.daily.length - 1].stars : undefined;
    if (starsToday !== undefined) {
      await upsertStarHistory(env.DB, project.repo, [{ date, stars: starsToday }]);
    }
  }
  return { ok: true };
}

async function collectPosts(env: Env, date: string, fetchFn: FetchFn): Promise<SourceResult> {
  const posts: Post[] = await listPosts(env.DB);
  const failures: string[] = [];
  for (const post of posts) {
    try {
      const metrics = await fetchPostMetrics(post.url, post.platform, fetchFn);
      await upsertPostMetrics(env.DB, post.id!, date, metrics);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${post.url}: ${msg}`);
    }
  }
  return failures.length > 0 ? { ok: false, error: failures.join("; ") } : { ok: true };
}

async function collectGoatcounter(env: Env, date: string, fetchFn: FetchFn): Promise<SourceResult> {
  if (!env.GOATCOUNTER_SITE || !env.GOATCOUNTER_TOKEN) {
    return { ok: true, error: "not configured" };
  }
  const rows = await fetchSiteDaily(env.GOATCOUNTER_SITE, env.GOATCOUNTER_TOKEN, date, date, fetchFn);
  await upsertSiteDaily(env.DB, rows);
  return { ok: true };
}

// TODO(Task 9): wire up the real freshness/health audit checks once implemented.
async function collectAudit(): Promise<SourceResult> {
  return { ok: true };
}

export async function runDailyCollect(env: Env, now: Date, fetchFn: FetchFn = fetch): Promise<CollectorReport[]> {
  const date = now.toISOString().slice(0, 10);
  return [
    await runSource(env.DB, "github", () => collectGithub(env, date, fetchFn)),
    await runSource(env.DB, "posts", () => collectPosts(env, date, fetchFn)),
    await runSource(env.DB, "goatcounter", () => collectGoatcounter(env, date, fetchFn)),
    await runSource(env.DB, "audit", () => collectAudit())
  ];
}
