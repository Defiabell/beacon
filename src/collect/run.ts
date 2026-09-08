import type { Env, Post } from "../types";
import type { FetchFn } from "./github";
import { fetchRepoMeta, fetchRepoTraffic } from "./github";
import { fetchPostMetrics } from "./posts";
import { fetchSiteDaily } from "./goatcounter";
import { fetchWorkerDaily } from "./cloudflare";
import { fetchRumDaily } from "./rum";
import { runAudit } from "../audit/run";
import { CONFIG } from "../config";
import {
  upsertRepoDaily,
  replaceReferrerSnapshot,
  upsertStarHistory,
  listPosts,
  upsertPostMetrics,
  upsertSiteDaily,
  upsertWorkerDaily,
  recordSourceRun
} from "../db";

export interface CollectorReport {
  source: string;
  ok: boolean;
  error?: string;
}

export type SourceName = "github" | "posts" | "goatcounter" | "cloudflare" | "rum" | "audit";
export const ALL_SOURCES: SourceName[] = ["github", "posts", "goatcounter", "cloudflare", "rum", "audit"];

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
    // Two stages, deliberately not one try block. The star count comes from
    // public repo metadata; traffic needs the repo to be inside the token's
    // fine-grained allowlist. Collapsing them meant a traffic 403 discarded a
    // star count that had already been fetched, and the project rendered as 0
    // stars — a number that looks like an answer. Now the star tally lands
    // regardless, and only the traffic half is reported as failed.
    let meta;
    try {
      meta = await fetchRepoMeta(env.GITHUB_TOKEN, project.repo, fetchFn);
      await upsertStarHistory(env.DB, project.repo, [{ date, stars: meta.stars }]);
    } catch (e) {
      failures.push(`${project.repo}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    try {
      const traffic = await fetchRepoTraffic(env.GITHUB_TOKEN, project.repo, meta, fetchFn);
      await upsertRepoDaily(env.DB, traffic.daily);
      await replaceReferrerSnapshot(env.DB, project.repo, date, traffic.referrers);
    } catch (e) {
      // No repo_daily row is written on this path, and that is the point: a row
      // of zeroes would assert "nobody visited today" when the truth is "we
      // were not allowed to look". An absent row renders as no data.
      failures.push(`${project.repo} traffic: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failures.length > 0 ? { ok: false, error: failures.join("; ") } : { ok: true };
}

async function collectPosts(env: Env, date: string, fetchFn: FetchFn): Promise<SourceResult> {
  const posts: Post[] = await listPosts(env.DB);
  const failures: string[] = [];
  for (const post of posts) {
    try {
      const metrics = await fetchPostMetrics(post.url, post.platform, fetchFn, env.GITHUB_TOKEN);
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

async function collectCloudflare(env: Env, date: string, fetchFn: FetchFn): Promise<SourceResult> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return { ok: true, error: "not configured" };
  }
  // A 3-day window rather than just `date`: Cloudflare restates recent days as
  // data settles, and re-fetching them lets upsertWorkerDaily correct earlier
  // undercounts. It also self-heals a missed run without a separate backfill.
  const start = new Date(`${date}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 2);
  const rows = await fetchWorkerDaily(
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_API_TOKEN,
    start.toISOString().slice(0, 10),
    date,
    fetchFn
  );
  await upsertWorkerDaily(env.DB, rows);
  return { ok: true };
}

async function collectRum(env: Env, date: string, fetchFn: FetchFn): Promise<SourceResult> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return { ok: true, error: "not configured" };
  }
  if (CONFIG.sites.length === 0) return { ok: true, error: "no sites configured" };
  // Same 3-day re-fetch window as the Worker collector: Cloudflare restates
  // recent days, and re-reading them lets the upsert correct earlier
  // undercounts and self-heal a missed run. All sites ride one aliased query,
  // so the whole fleet costs a single subrequest.
  const start = new Date(`${date}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 2);
  const rows = await fetchRumDaily(
    CONFIG.sites,
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_API_TOKEN,
    start.toISOString().slice(0, 10),
    date,
    fetchFn
  );
  await upsertSiteDaily(env.DB, rows);
  return { ok: true };
}

async function collectAudit(env: Env, fetchFn: FetchFn, shard: number): Promise<SourceResult> {
  await runAudit(env, fetchFn, shard);
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
  sources: SourceName[] = ALL_SOURCES,
  // Which audit shard to run. Ignored unless "audit" is among `sources`.
  // Each shard is a slice of the fleet small enough to fit one invocation's
  // subrequest budget; see src/audit/run.ts auditShards.
  auditShard = 0
): Promise<CollectorReport[]> {
  const date = now.toISOString().slice(0, 10);
  const reports: CollectorReport[] = [];
  if (sources.includes("github")) reports.push(await runSource(env.DB, "github", () => collectGithub(env, date, fetchFn)));
  if (sources.includes("posts")) reports.push(await runSource(env.DB, "posts", () => collectPosts(env, date, fetchFn)));
  if (sources.includes("goatcounter")) {
    reports.push(await runSource(env.DB, "goatcounter", () => collectGoatcounter(env, date, fetchFn)));
  }
  if (sources.includes("cloudflare")) {
    reports.push(await runSource(env.DB, "cloudflare", () => collectCloudflare(env, date, fetchFn)));
  }
  if (sources.includes("rum")) reports.push(await runSource(env.DB, "rum", () => collectRum(env, date, fetchFn)));
  if (sources.includes("audit")) {
    reports.push(await runSource(env.DB, "audit", () => collectAudit(env, fetchFn, auditShard)));
  }
  return reports;
}
