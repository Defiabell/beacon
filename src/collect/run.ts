import type { Env, Post } from "../types";
import type { FetchFn } from "./github";
import { fetchRepoTraffic } from "./github";
import { fetchPostMetrics } from "./posts";
import { fetchSiteDaily } from "./goatcounter";
import { runAudit } from "../audit/run";
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

export type SourceName = "github" | "posts" | "goatcounter" | "audit";
export const ALL_SOURCES: SourceName[] = ["github", "posts", "goatcounter", "audit"];

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
  const failures: string[] = [];
  for (const project of CONFIG.projects) {
    try {
      const traffic = await fetchRepoTraffic(env.GITHUB_TOKEN, project.repo, fetchFn);
      await upsertRepoDaily(env.DB, traffic.daily);
      await replaceReferrerSnapshot(env.DB, project.repo, date, traffic.referrers);
      // Every row in `traffic.daily` carries the same (current) stargazers_count,
      // fetched once from the repo-meta call inside fetchRepoTraffic — so any
      // element gives us "today's" star tally. When there's no traffic data at
      // all (no views/clones in the response window), there's nothing to read
      // the count off of, so we simply skip the star_history write for this repo.
      // (Empirically GitHub zero-fills the 14-day traffic window, so this is
      // defensive rather than an expected path on a successful call.)
      const starsToday = traffic.daily.length > 0 ? traffic.daily[traffic.daily.length - 1].stars : undefined;
      if (starsToday !== undefined) {
        await upsertStarHistory(env.DB, project.repo, [{ date, stars: starsToday }]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${project.repo}: ${msg}`);
    }
  }
  return failures.length > 0 ? { ok: false, error: failures.join("; ") } : { ok: true };
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

async function collectAudit(env: Env, fetchFn: FetchFn): Promise<SourceResult> {
  await runAudit(env, fetchFn);
  return { ok: true };
}

// `sources` (default: all four) lets a caller run only a subset — used to
// split the daily cron across two invocations (see wrangler.toml / src/index.ts's
// scheduled handler) and by the admin ?sources= query param (src/api/admin.ts),
// both in service of staying under the Workers free tier's
// 50-subrequests-per-invocation cap on a multi-repo fleet. recordSourceRun
// behavior is unchanged: only the sources actually run get a source_runs row
// written/updated this invocation.
export async function runDailyCollect(
  env: Env,
  now: Date,
  fetchFn: FetchFn = fetch,
  sources: SourceName[] = ALL_SOURCES
): Promise<CollectorReport[]> {
  const date = now.toISOString().slice(0, 10);
  const reports: CollectorReport[] = [];
  if (sources.includes("github")) reports.push(await runSource(env.DB, "github", () => collectGithub(env, date, fetchFn)));
  if (sources.includes("posts")) reports.push(await runSource(env.DB, "posts", () => collectPosts(env, date, fetchFn)));
  if (sources.includes("goatcounter")) {
    reports.push(await runSource(env.DB, "goatcounter", () => collectGoatcounter(env, date, fetchFn)));
  }
  if (sources.includes("audit")) reports.push(await runSource(env.DB, "audit", () => collectAudit(env, fetchFn)));
  return reports;
}
