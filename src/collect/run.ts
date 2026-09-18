import type { Env, Post } from "../types";
import type { FetchFn } from "./github";
import { fetchRepoMeta, fetchRepoTraffic } from "./github";
import { fetchPostMetrics } from "./posts";
import { fetchSiteDaily } from "./goatcounter";
import { fetchWorkerDaily } from "./cloudflare";
import { fetchRumDaily } from "./rum";
import { fetchPagesFunctionsDaily, fetchPagesProjects, resolvePagesFunctionsToWorkerDaily } from "./pages";
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

export type SourceName = "github" | "posts" | "goatcounter" | "cloudflare" | "pages" | "rum" | "audit";
export const ALL_SOURCES: SourceName[] = ["github", "posts", "goatcounter", "cloudflare", "pages", "rum", "audit"];

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

function datesEndingOn(date: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(`${date}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - days + 1 + i);
    return day.toISOString().slice(0, 10);
  });
}

function analyticsDates(date: string): string[] {
  const yesterday = new Date(`${date}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return datesEndingOn(yesterday.toISOString().slice(0, 10), 3);
}

async function collectGithub(env: Env, date: string, fetchFn: FetchFn): Promise<SourceResult> {
  const failures: string[] = [];
  for (const project of CONFIG.projects) {
    let failure: string | undefined;
    let meta;
    try {
      meta = await fetchRepoMeta(env.GITHUB_TOKEN, project.repo, fetchFn);
      await upsertStarHistory(env.DB, project.repo, [{ date, stars: meta.stars }]);
    } catch (e) {
      failure = `${project.repo}: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (meta && !failure) {
      try {
        const traffic = await fetchRepoTraffic(env.GITHUB_TOKEN, project.repo, meta, fetchFn);
        // Only a successful traffic response establishes zero for absent days.
        // GitHub retains 14 days including today; never extrapolate beyond it.
        const byDate = new Map(traffic.daily.map(row => [row.date, row]));
        for (const day of datesEndingOn(date, 14)) {
          if (!byDate.has(day)) byDate.set(day, {
            repo: project.repo, date: day, views: 0, uniqueViews: 0,
            clones: 0, uniqueClones: 0, stars: meta.stars, forks: meta.forks
          });
        }
        // The API can also return the boundary day's real bucket (T-14).
        // Preserve every measured row, but never invent an older zero.
        await upsertRepoDaily(env.DB, [...byDate.values()]);
        await replaceReferrerSnapshot(env.DB, project.repo, date, traffic.referrers);
      } catch (e) {
        failure = `${project.repo} traffic: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    await recordSourceRun(env.DB, `github:${project.repo}`, !failure, failure);
    if (failure) failures.push(failure);
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
  const dates = analyticsDates(date);
  const rows = await fetchSiteDaily(env.GOATCOUNTER_SITE, env.GOATCOUNTER_TOKEN, dates[0], dates[2], fetchFn);
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
  const dates = analyticsDates(date);
  const rows = await fetchWorkerDaily(
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_API_TOKEN,
    dates[0],
    dates[2],
    fetchFn
  );
  await upsertWorkerDaily(env.DB, rows);
  return { ok: true };
}

// Same account/token as collectCloudflare (not a separate credential pair):
// the Pages Functions dataset and the Pages project list both live under this
// account, and both were confirmed live 2026-09-15 to work with the token
// already granted for workersInvocationsAdaptive — see src/collect/pages.ts.
async function collectPages(env: Env, date: string, fetchFn: FetchFn): Promise<SourceResult> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return { ok: true, error: "not configured" };
  }
  // Same 3-day re-fetch window as collectCloudflare/collectRum, and for the
  // same reason: Cloudflare restates recent days as data settles.
  const dates = analyticsDates(date);
  const [rows, projects] = await Promise.all([
    fetchPagesFunctionsDaily(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_TOKEN,
      dates[0],
      dates[2],
      fetchFn
    ),
    fetchPagesProjects(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN, fetchFn)
  ]);
  const daily = resolvePagesFunctionsToWorkerDaily(rows, projects);
  // Only scripts present in Functions analytics are known to run Functions.
  // A Pages project list alone also contains purely static sites.
  const byKey = new Map(daily.map(row => [`${row.script}:${row.date}`, row]));
  for (const script of new Set(daily.map(row => row.script))) {
    for (const day of dates) {
      const key = `${script}:${day}`;
      if (!byKey.has(key)) byKey.set(key, { script, date: day, requests: 0, errors: 0, subrequests: 0 });
    }
  }
  await upsertWorkerDaily(env.DB, [...byKey.values()]);
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
  const dates = analyticsDates(date);
  const rows = await fetchRumDaily(
    CONFIG.sites,
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_API_TOKEN,
    dates[0],
    dates[2],
    fetchFn
  );
  const byKey = new Map(rows.map(row => [`${row.site}:${row.date}`, row]));
  for (const site of CONFIG.sites) {
    for (const day of dates) {
      const key = `${site.host}:${day}`;
      if (!byKey.has(key)) byKey.set(key, { site: site.host, date: day, pageviews: 0, visitors: 0 });
    }
  }
  await upsertSiteDaily(env.DB, [...byKey.values()]);
  return { ok: true };
}

async function collectAudit(env: Env, fetchFn: FetchFn, shard: number): Promise<SourceResult> {
  await runAudit(env, fetchFn, shard);
  return { ok: true };
}

// Scheduled invocations select one bounded group (see schedule.ts). Admin
// callers can still explicitly request a source subset. Only sources actually
// run receive health records; GitHub additionally records per-repo health.
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
  if (sources.includes("pages")) {
    reports.push(await runSource(env.DB, "pages", () => collectPages(env, date, fetchFn)));
  }
  if (sources.includes("rum")) reports.push(await runSource(env.DB, "rum", () => collectRum(env, date, fetchFn)));
  if (sources.includes("audit")) {
    reports.push(await runSource(env.DB, "audit", () => collectAudit(env, fetchFn, auditShard)));
  }
  return reports;
}
