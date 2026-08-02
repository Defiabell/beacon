import type { Env, RepoDaily, ReferrerRow, Post, PostMetrics, Todo, CheckResult, SourceRun } from "../types";
import type { ProjectConfig } from "../config";
import { CONFIG } from "../config";
import { CHANNELS, suggestPairs, type Suggestion } from "../channels";
import {
  getStarSeries,
  getRepoSeries,
  getLatestReferrers,
  listPosts,
  latestPostMetrics,
  listProjectChannels,
  listSourceRuns,
  listTodos,
  getTopOpenTodos,
  getSitePvSum,
  listAuditResults
} from "../db";

const REPO_SERIES_SUMMARY_DAYS = 14;
const REPO_SERIES_DETAIL_DAYS = 90;
const SITE_PV_WINDOW_DAYS = 7;
const STAR_DELTA_WINDOW_DAYS = 7;
const TOP_TODOS_LIMIT = 5;
const TOP_REFERRERS_LIMIT = 5;

export interface ProjectSummary {
  project: string;
  repo: string;
  stars: number;
  starsDelta7d: number;
  views14d: number;
  clones14d: number;
  postCount: number;
  topReferrers: ReferrerRow[];
}

export interface Overview {
  projects: ProjectSummary[];
  topTodos: Todo[];
  suggestions: Suggestion[];
  sources: SourceRun[];
  sitePv7d: number;
}

export interface PostWithMetrics {
  post: Post;
  latest: (PostMetrics & { date: string }) | null;
}

export interface ProjectDetail {
  summary: ProjectSummary;
  repoSeries: RepoDaily[];
  starSeries: { date: string; stars: number }[];
  referrers: ReferrerRow[];
  posts: PostWithMetrics[];
  audit: (CheckResult & { checkedAt: string })[];
}

export interface MatrixData {
  projects: string[];
  channels: { id: string; name: string; lang: string }[];
  coverage: { project: string; channelId: string; status: string }[];
  suggestions: Suggestion[];
}

// Shifts a "YYYY-MM-DD" date string by `deltaDays` (may be negative) using UTC
// calendar arithmetic — avoids local-timezone drift shifting the date part.
function shiftDate(date: string, deltaDays: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// starsDelta7d = latest star count minus the count at (or nearest before) 7
// days prior to the latest recorded date. `series` is ascending by date (as
// returned by getStarSeries). When fewer than 7 days of history exist — no row
// has a date <= the 7-days-back target — the earliest row is used as the
// baseline instead, per the task-11 spec.
// Exported (beyond the required public.ts contract) so this pure branch logic
// can be unit-tested directly, the same way src/audit/checks.ts's pure
// functions are tested without going through the HTTP layer.
export function computeStarsDelta(series: { date: string; stars: number }[]): { stars: number; starsDelta7d: number } {
  if (series.length === 0) return { stars: 0, starsDelta7d: 0 };
  const latest = series[series.length - 1];
  const targetDate = shiftDate(latest.date, -STAR_DELTA_WINDOW_DAYS);
  let baseline = series[0];
  for (const row of series) {
    if (row.date <= targetDate) baseline = row;
    else break;
  }
  return { stars: latest.stars, starsDelta7d: latest.stars - baseline.stars };
}

function computeProjectSummary(
  project: ProjectConfig,
  starSeries: { date: string; stars: number }[],
  repoSeries: RepoDaily[],
  referrers: ReferrerRow[],
  postCount: number
): ProjectSummary {
  const { stars, starsDelta7d } = computeStarsDelta(starSeries);
  const views14d = repoSeries.reduce((sum, r) => sum + r.views, 0);
  const clones14d = repoSeries.reduce((sum, r) => sum + r.clones, 0);
  return {
    project: project.name,
    repo: project.repo,
    stars,
    starsDelta7d,
    views14d,
    clones14d,
    postCount,
    topReferrers: referrers.slice(0, TOP_REFERRERS_LIMIT)
  };
}

async function fetchProjectSummary(db: D1Database, project: ProjectConfig, allPosts: Post[]): Promise<ProjectSummary> {
  const [starSeries, repoSeries, referrers] = await Promise.all([
    getStarSeries(db, project.repo),
    getRepoSeries(db, project.repo, REPO_SERIES_SUMMARY_DAYS),
    getLatestReferrers(db, project.repo)
  ]);
  const postCount = allPosts.filter(p => p.project === project.name).length;
  return computeProjectSummary(project, starSeries, repoSeries, referrers, postCount);
}

// listProjectChannels also carries postId, which the public coverage/matrix
// shapes deliberately don't expose.
function toCoverage(
  rows: { project: string; channelId: string; status: string }[]
): { project: string; channelId: string; status: string }[] {
  return rows.map(r => ({ project: r.project, channelId: r.channelId, status: r.status }));
}

export async function buildOverview(env: Env): Promise<Overview> {
  const db = env.DB;
  const [allPosts, coverageRows, sources, sitePv7d, topTodos] = await Promise.all([
    listPosts(db),
    listProjectChannels(db),
    listSourceRuns(db),
    getSitePvSum(db, SITE_PV_WINDOW_DAYS),
    getTopOpenTodos(db, TOP_TODOS_LIMIT)
  ]);
  const projects = await Promise.all(CONFIG.projects.map(p => fetchProjectSummary(db, p, allPosts)));
  const suggestions = suggestPairs(CONFIG.projects, toCoverage(coverageRows));
  return { projects, topTodos, suggestions, sources, sitePv7d };
}

// Returns null when `name` doesn't match a configured project (caller maps
// that to a 404).
export async function buildProjectDetail(env: Env, name: string): Promise<ProjectDetail | null> {
  const project = CONFIG.projects.find(p => p.name === name);
  if (!project) return null;

  const db = env.DB;
  const [starSeries, repoSeriesSummary, repoSeries, referrers, allPosts, audit] = await Promise.all([
    getStarSeries(db, project.repo),
    getRepoSeries(db, project.repo, REPO_SERIES_SUMMARY_DAYS),
    getRepoSeries(db, project.repo, REPO_SERIES_DETAIL_DAYS),
    getLatestReferrers(db, project.repo),
    listPosts(db),
    listAuditResults(db, project.name)
  ]);
  const projectPosts = allPosts.filter(p => p.project === project.name);
  const posts: PostWithMetrics[] = await Promise.all(
    projectPosts.map(async post => ({ post, latest: await latestPostMetrics(db, post.id!) }))
  );
  const summary = computeProjectSummary(project, starSeries, repoSeriesSummary, referrers, projectPosts.length);

  return { summary, repoSeries, starSeries, referrers, posts, audit };
}

export async function buildMatrix(env: Env): Promise<MatrixData> {
  const db = env.DB;
  const coverage = toCoverage(await listProjectChannels(db));
  const suggestions = suggestPairs(CONFIG.projects, coverage);
  return {
    projects: CONFIG.projects.map(p => p.name),
    channels: CHANNELS.map(c => ({ id: c.id, name: c.name, lang: c.lang })),
    coverage,
    suggestions
  };
}

async function buildPostsWithMetrics(env: Env): Promise<PostWithMetrics[]> {
  const db = env.DB;
  const posts = await listPosts(db);
  return Promise.all(posts.map(async post => ({ post, latest: await latestPostMetrics(db, post.id!) })));
}

const CACHE_CONTROL = "public, max-age=60, s-maxage=600";

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": CACHE_CONTROL
    }
  });
}

function jsonError(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

const PROJECT_PATH = /^\/api\/project\/([^/]+)$/;

// `path` is the request's URL.pathname, matched together with req.method —
// mirrors handleAdmin's (src/api/admin.ts) contract.
//
// IMPORTANT: /api/admin/* is deliberately excluded (returns null, same as any
// non-/api/ path) rather than handled here. handleAdmin owns that whole
// subtree, including its own auth and non-GET methods (POST/PUT). Task 12's
// router must dispatch /api/admin/* to handleAdmin — either by trying it
// first, or by checking the admin prefix before falling back to this
// function — otherwise this function's null return would need to be the only
// thing standing between an unauthenticated request and... nothing, since
// this function itself never touches admin data. The exclusion is a routing
// contract, not a security boundary: this function has no state-changing
// route at all, so it currently could not disturb the admin subtree.
export async function handlePublicApi(req: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/") || path.startsWith("/api/admin/")) return null;

  if (req.method !== "GET") return jsonError({ error: "method not allowed" }, 405);

  if (path === "/api/overview") return jsonOk(await buildOverview(env));
  if (path === "/api/matrix") return jsonOk(await buildMatrix(env));
  if (path === "/api/posts") return jsonOk(await buildPostsWithMetrics(env));
  if (path === "/api/health") return jsonOk(await listSourceRuns(env.DB));

  if (path === "/api/todos") {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") === "done" ? "done" : "open";
    return jsonOk(await listTodos(env.DB, status));
  }

  const projectMatch = path.match(PROJECT_PATH);
  if (projectMatch) {
    let name: string;
    try {
      name = decodeURIComponent(projectMatch[1]);
    } catch {
      // Malformed percent-encoding (e.g. "%zz") makes decodeURIComponent throw
      // a URIError rather than returning something falsy. This is a public,
      // unauthenticated endpoint with no upstream catch — without this guard
      // that throw would 500 the whole request instead of the same 404 an
      // unknown-but-well-formed project name gets.
      return jsonError({ error: "not found" }, 404);
    }
    const detail = await buildProjectDetail(env, name);
    if (!detail) return jsonError({ error: "not found" }, 404);
    return jsonOk(detail);
  }

  return jsonError({ error: "not found" }, 404);
}
