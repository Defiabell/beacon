import type { Env, RepoDaily, ReferrerRow, Post, PostMetrics, Todo, CheckResult, SourceRun } from "../types";
import type { ProjectConfig } from "../config";
import { CONFIG } from "../config";
import {
  CHANNELS,
  suggestPairs,
  referrerMatchesChannel,
  channelHasSharedReferrerHost,
  type Suggestion,
  type ChannelKind,
  type Channel
} from "../channels";
import { classifyDay } from "../impact/classify";
import { SURFACES, classifyReferrer, type SurfaceId } from "../surfaces";
import {
  getStarSeries,
  getRepoSeries,
  getAllRepoDaily,
  getLatestReferrers,
  getPeakReferrers,
  getWorkerTotals,
  getSiteTotals,
  listPosts,
  listPostsForImpact,
  latestPostMetrics,
  listProjectChannels,
  listSourceRuns,
  listTodos,
  getTopOpenTodos,
  getSitePvSum,
  listAuditResults,
  type PostForImpact,
  type PeakReferrer,
  type SiteTotal
} from "../db";
import {
  shiftDate,
  buildEvents,
  computeImpact,
  computeImpacts,
  type ImpactEvent,
  type EventImpact,
  type ImpactStatus,
  type TodoEventInput
} from "../impact/attribute";

const REPO_SERIES_SUMMARY_DAYS = 14;
const REPO_SERIES_DETAIL_DAYS = 90;
const SITE_PV_WINDOW_DAYS = 7;
const STAR_DELTA_WINDOW_DAYS = 7;
const TOP_TODOS_LIMIT = 5;
const TOP_REFERRERS_LIMIT = 5;
const WORKER_WINDOW_DAYS = 7;

export interface ProjectSummary {
  project: string;
  repo: string;
  stars: number;
  starsDelta7d: number;
  views14d: number;
  // Human-only clone count (classifyDay-filtered — design doc §3), NOT a raw
  // sum of repo_daily.clones. Review item 1: the raw sum used to be what this
  // field held, which silently folded bot/CI clone spikes into the number a
  // reader sees labeled "clones 14d" — nightide alone has 109 machine clones
  // in 14 days. machineClones14d (below) discloses that count separately; the
  // two are never added together anywhere in the UI.
  clones14d: number;
  machineClones14d: number;
  postCount: number;
  topReferrers: ReferrerRow[];
}

// Trailing-window request counts for this account's Workers.
//
// REQUESTS, not visits — see src/collect/cloudflare.ts for why the two differ
// by more than an order of magnitude. The UI must never relabel this as
// traffic; where a visit estimate is shown it carries its own divisor and the
// word "约".
export interface WorkerTotal {
  script: string;
  requests: number;
  errors: number;
  days: number;
}

export interface Overview {
  projects: ProjectSummary[];
  topTodos: Todo[];
  suggestions: Suggestion[];
  sources: SourceRun[];
  sitePv7d: number;
  surfaces: SurfaceBreakdown;
  workers: WorkerTotal[];
  sites: SiteTotal[];
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
  // Optional (rather than required) so existing ProjectDetail literals built
  // before this feature — tests, mainly — keep typechecking without every one
  // of them needing an `events: []`. Always populated (possibly []) by
  // buildProjectDetail below.
  events?: EventImpact[];
}

// Compact summary of a post's impact, attached to a "posted" matrix cell that
// has a postId link (design doc §5 — "附带该渠道对应帖子的实际效果"). `views`/
// `starsDelta` are the after-window's own totals, not a delta against the
// before-window baseline — subtracting two windows of possibly different
// `days` (a still-collecting after-window has fewer recorded days than
// before) would silently compare apples to oranges. `status`/`days` are
// carried alongside for exactly the same honesty reason EventImpact carries
// them: the UI must never show these numbers as a finished conclusion when
// `status !== "complete"`.
export interface MatrixEffect {
  views: number;
  humanClones: number;
  starsDelta: number;
  status: ImpactStatus;
  days: number;
}

// What this channel actually referred to the project's repo, read straight out
// of GitHub's traffic referrers rather than inferred from a time window.
//
// This exists because `effect` above cannot separate two channels that fire in
// the same week: it credits an event with whatever the repo did in the ±7 days
// around it, so a submission that lands inside somebody else's wave inherits
// that wave. Not hypothetical — shotsync's GitHubDaily submission (2026-08-24,
// never picked up, still zero comments and zero labels) was being shown as +128
// views / +14 stars, every one of which belonged to 阮一峰周刊's 08-21 spike.
// Referrers do not have that failure mode: they are attributed by construction.
export interface ReferredTraffic {
  views: number;
  uniques: number;
  // Snapshot dates bounding the observation. Useful for telling "arrived and
  // stopped" (a frozen lastSeen) from "still arriving".
  firstSeen: string | null;
  lastSeen: string | null;
  // This channel shares its publication host with another channel, so the
  // numbers describe the host, not this channel alone.
  sharedHost: boolean;
  // The linked post predates our first referrer snapshot for this repo, so a
  // zero reading here means "we were not watching", not "referred nobody".
  // GitHub only ever serves a 14-day referrer window, so traffic older than
  // our earliest capture has already decayed out of it and can never be
  // recovered. nightide's V2EX post (2026-07-27) sits before beacon's first
  // snapshot (2026-08-09) and was being reported as a flat 引流 0 — the exact
  // "no data read as zero" mistake this whole type exists to prevent, which
  // the first version of it committed anyway.
  predatesCoverage: boolean;
}

export interface MatrixCoverageRow {
  project: string;
  channelId: string;
  status: string;
  effect?: MatrixEffect;
  // undefined = the channel declares no referrer hosts, i.e. it is not
  // observable this way at all (publishes off-web, or its host is too generic
  // to attribute). A present object with views 0 is the opposite and much
  // stronger claim: the channel is observable and referred nobody. Collapsing
  // those two into one "0" is exactly the mistake this field exists to avoid.
  referred?: ReferredTraffic;
}

// `url`/`kind`/`howTo` all already existed on src/channels.ts's Channel but
// were dropped on the way out of buildMatrix, so a reader of the matrix saw a
// channel *name* with no way to reach it and no statement of what "posting"
// there even involves — the gap that made the page unusable without someone
// explaining it. They're plain editorial constants (no per-project state), so
// exposing them costs nothing beyond payload size.
export interface MatrixChannel {
  id: string;
  name: string;
  lang: string;
  url: string;
  kind: ChannelKind;
  howTo: string;
}

export interface MatrixData {
  projects: string[];
  channels: MatrixChannel[];
  coverage: MatrixCoverageRow[];
  suggestions: Suggestion[];
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
  // classifyDay's per-day split, summed across the window — see the doc
  // comment on ProjectSummary.clones14d above.
  const { humanClones, machineClones } = repoSeries.reduce(
    (acc, r) => {
      const c = classifyDay(r);
      return { humanClones: acc.humanClones + c.humanClones, machineClones: acc.machineClones + c.machineClones };
    },
    { humanClones: 0, machineClones: 0 }
  );
  return {
    project: project.name,
    repo: project.repo,
    stars,
    starsDelta7d,
    views14d,
    clones14d: humanClones,
    machineClones14d: machineClones,
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

// ---- impact (design doc §4) -------------------------------------------------

// Shared by buildImpact/buildProjectDetail/buildMatrix below — every one of
// them needs the full post/done-todo list to build ImpactEvent[] from, and
// none of them should duplicate the "which todos have a doneAt" filtering.
// listTodos(db, "done") always populates doneAt (see setTodoStatus) but the
// Todo type itself still declares it optional, hence the filter+cast.
async function fetchEventInputs(db: D1Database): Promise<{ postRows: PostForImpact[]; todoInputs: TodoEventInput[] }> {
  const [postRows, doneTodos] = await Promise.all([listPostsForImpact(db), listTodos(db, "done")]);
  const todoInputs: TodoEventInput[] = doneTodos
    .filter((t): t is Todo & { doneAt: string } => !!t.doneAt)
    .map(t => ({ project: t.project, title: t.title, doneAt: t.doneAt }));
  return { postRows, todoInputs };
}

interface ProjectImpactData {
  repoDaily: RepoDaily[];
  starHistory: { date: string; stars: number }[];
}

// Full (unbounded) repo_daily + star_history per configured project — an
// event's before/after window can fall anywhere in a project's history, not
// just within the chart-oriented 14d/90d windows used elsewhere in this file.
async function fetchImpactDataByProject(db: D1Database): Promise<Map<string, ProjectImpactData>> {
  const entries = await Promise.all(
    CONFIG.projects.map(async (p): Promise<readonly [string, ProjectImpactData]> => {
      const [repoDaily, starHistory] = await Promise.all([getAllRepoDaily(db, p.repo), getStarSeries(db, p.repo)]);
      return [p.name, { repoDaily, starHistory }] as const;
    })
  );
  return new Map(entries);
}

// GET /api/impact (below) and /impact's SSR page (src/ui/pages.ts's
// renderImpact) both read this directly.
export async function buildImpact(env: Env): Promise<EventImpact[]> {
  const db = env.DB;
  const { postRows, todoInputs } = await fetchEventInputs(db);
  const events = buildEvents(postRows, todoInputs);
  const dataByProject = await fetchImpactDataByProject(db);
  return computeImpacts(events, dataByProject);
}

// Keyed by posts.id — used by buildMatrix below to attach a MatrixEffect to
// exactly the channel cell a given post was registered against (via
// project_channels.post_id, set by the JSON admin API's PUT
// /api/admin/channels — never by the no-JS /ui/channel form).
async function buildImpactByPostId(env: Env): Promise<Map<number, EventImpact>> {
  const impacts = await buildImpact(env);
  return new Map(
    impacts
      .filter((i): i is EventImpact & { event: ImpactEvent & { postId: number } } => i.event.kind === "post" && i.event.postId != null)
      .map(i => [i.event.postId, i])
  );
}

function toMatrixEffect(impact: EventImpact): MatrixEffect {
  return { views: impact.after.views, humanClones: impact.after.humanClones, starsDelta: impact.after.starsDelta, status: impact.status, days: impact.after.days };
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

  const peaksByProject = new Map<string, PeakReferrer[]>();
  for (const p of CONFIG.projects) peaksByProject.set(p.name, await getPeakReferrers(db, p.repo));

  const workers = await getWorkerTotals(db, WORKER_WINDOW_DAYS);
  const sites = await getSiteTotals(db, SITE_PV_WINDOW_DAYS);
  return {
    projects,
    topTodos,
    suggestions,
    sources,
    sitePv7d,
    surfaces: buildSurfaceBreakdown(peaksByProject),
    workers,
    sites
  };
}

// Returns null when `name` doesn't match a configured project (caller maps
// that to a 404).
export async function buildProjectDetail(env: Env, name: string): Promise<ProjectDetail | null> {
  const project = CONFIG.projects.find(p => p.name === name);
  if (!project) return null;

  const db = env.DB;
  const [starSeries, repoSeriesSummary, repoSeries, repoDailyAll, referrers, allPosts, audit, eventInputs] = await Promise.all([
    getStarSeries(db, project.repo),
    getRepoSeries(db, project.repo, REPO_SERIES_SUMMARY_DAYS),
    getRepoSeries(db, project.repo, REPO_SERIES_DETAIL_DAYS),
    getAllRepoDaily(db, project.repo),
    getLatestReferrers(db, project.repo),
    listPosts(db),
    listAuditResults(db, project.name),
    fetchEventInputs(db)
  ]);
  const projectPosts = allPosts.filter(p => p.project === project.name);
  const posts: PostWithMetrics[] = await Promise.all(
    projectPosts.map(async post => ({ post, latest: await latestPostMetrics(db, post.id!) }))
  );
  const summary = computeProjectSummary(project, starSeries, repoSeriesSummary, referrers, projectPosts.length);

  // starSeries above is already full (unbounded) history — getStarSeries has
  // no `days` limit, unlike getRepoSeries — so it's reused as-is for impact;
  // only repo_daily needed the separate unbounded fetch (repoDailyAll).
  const events = buildEvents(eventInputs.postRows, eventInputs.todoInputs).filter(e => e.project === project.name);
  const projectEvents = events.map(e => computeImpact(e, repoDailyAll, starSeries));

  return { summary, repoSeries, starSeries, referrers, posts, audit, events: projectEvents };
}

export interface SurfaceRow {
  id: SurfaceId;
  name: string;
  note: string;
  views: number;
  uniques: number;
  // The specific hosts that landed in this bucket, so a reader can check the
  // classification instead of trusting it.
  hosts: string[];
}

export interface SurfaceBreakdown {
  surfaces: SurfaceRow[];
  // Referrers no surface claims, listed individually and never summed into an
  // anonymous "other" row — see classifyReferrer's comment for why. Descending
  // by views.
  unclassified: { referrer: string; views: number; uniques: number }[];
  // Earliest snapshot across all repos: everything here is bounded by when
  // beacon started watching, and GitHub only serves a 14-day window, so
  // traffic older than this was never observable.
  since: string | null;
}

// Aggregated across every configured project — the question "is any AI answer
// engine sending anyone yet?" is about the whole portfolio, not one repo, and
// per-repo the counts are too small to read.
export function buildSurfaceBreakdown(peaksByProject: Map<string, PeakReferrer[]>): SurfaceBreakdown {
  const totals = new Map<SurfaceId, { views: number; uniques: number; hosts: Set<string> }>();
  const unclassified = new Map<string, { views: number; uniques: number }>();
  let since: string | null = null;

  for (const peaks of peaksByProject.values()) {
    for (const p of peaks) {
      if (since === null || p.firstSeen < since) since = p.firstSeen;
      const id = classifyReferrer(p.referrer);
      if (id === null) {
        const prev = unclassified.get(p.referrer) ?? { views: 0, uniques: 0 };
        unclassified.set(p.referrer, { views: prev.views + p.views, uniques: prev.uniques + p.uniques });
        continue;
      }
      const prev = totals.get(id) ?? { views: 0, uniques: 0, hosts: new Set<string>() };
      prev.views += p.views;
      prev.uniques += p.uniques;
      prev.hosts.add(p.referrer);
      totals.set(id, prev);
    }
  }

  return {
    // Every surface is emitted, including empty ones. A zero row is the whole
    // point for the AI bucket: "nobody has arrived from an AI answer engine" is
    // a finding, and it disappears if empty rows are filtered out.
    surfaces: SURFACES.map(s => {
      const t = totals.get(s.id);
      return {
        id: s.id,
        name: s.name,
        note: s.note,
        views: t?.views ?? 0,
        uniques: t?.uniques ?? 0,
        hosts: t ? [...t.hosts].sort() : []
      };
    }),
    unclassified: [...unclassified]
      .map(([referrer, v]) => ({ referrer, ...v }))
      .sort((a, b) => b.views - a.views),
    since
  };
}

// Sums every referrer host the channel claims. A channel can legitimately own
// more than one (小众软件 owns both its forum and its article site) and a repo
// can be referred by several of them at once.
//
// Exported for direct unit testing: the whole point is which of three outcomes
// you get — undefined (unobservable), zeroes (observable, referred nobody), or
// real numbers — and routing that through D1 would obscure it.
export function referredTrafficFor(
  channel: Channel,
  peaks: PeakReferrer[],
  postedAt: string | null = null
): ReferredTraffic | undefined {
  if (channel.referrerHosts.length === 0) return undefined;
  const hits = peaks.filter(p => referrerMatchesChannel(p.referrer, channel));
  // Earliest capture for the whole repo, not just the matched hosts — the
  // question is when beacon started watching this repo at all, and a channel
  // with no hits has no firstSeen of its own to answer it with.
  const coverageStart = peaks.length ? peaks.map(p => p.firstSeen).sort()[0] : null;
  return {
    views: hits.reduce((n, h) => n + h.views, 0),
    uniques: hits.reduce((n, h) => n + h.uniques, 0),
    firstSeen: hits.length ? hits.map(h => h.firstSeen).sort()[0] : null,
    lastSeen: hits.length ? hits.map(h => h.lastSeen).sort().slice(-1)[0] : null,
    sharedHost: channelHasSharedReferrerHost(channel),
    // No coverage at all is also "not watching". An unlinked cell (postedAt
    // null) makes no claim about when it was posted, so it can't be shown to
    // predate anything and stays false.
    predatesCoverage: postedAt !== null && (coverageStart === null || postedAt < coverageStart)
  };
}

export async function buildMatrix(env: Env): Promise<MatrixData> {
  const db = env.DB;
  const rawCoverage = await listProjectChannels(db);
  const coverage = toCoverage(rawCoverage);
  const suggestions = suggestPairs(CONFIG.projects, coverage);

  // The impact fetch (buildImpact runs the full events + per-project
  // repo_daily/star_history pipeline) is only worth its cost when there's at
  // least one posted+postId-linked cell to attach it to.
  const postedWithPostId = rawCoverage.filter(r => r.status === "posted" && r.postId != null);
  const impactByPostId = postedWithPostId.length > 0 ? await buildImpactByPostId(env) : new Map<number, EventImpact>();

  // One query per project rather than one per cell: the peak-referrer set is a
  // property of the repo, and every channel row for that project reads from it.
  const peaksByProject = new Map<string, PeakReferrer[]>();
  for (const p of CONFIG.projects) peaksByProject.set(p.name, await getPeakReferrers(db, p.repo));

  // Post publish dates, needed to tell "referred nobody" from "posted before we
  // started watching" (see ReferredTraffic.predatesCoverage).
  const postedAtById = new Map<number, string | null>();
  for (const post of await listPosts(db)) if (post.id != null) postedAtById.set(post.id, post.publishedAt);

  const richCoverage: MatrixCoverageRow[] = coverage.map(c => {
    const raw = rawCoverage.find(r => r.project === c.project && r.channelId === c.channelId);
    const impact = raw?.postId != null ? impactByPostId.get(raw.postId) : undefined;
    const channel = CHANNELS.find(ch => ch.id === c.channelId);
    const postedAt = raw?.postId != null ? postedAtById.get(raw.postId) ?? null : null;
    return {
      ...c,
      effect: impact ? toMatrixEffect(impact) : undefined,
      referred: channel ? referredTrafficFor(channel, peaksByProject.get(c.project) ?? [], postedAt) : undefined
    };
  });

  return {
    projects: CONFIG.projects.map(p => p.name),
    channels: CHANNELS.map(c => ({ id: c.id, name: c.name, lang: c.lang, url: c.url, kind: c.kind, howTo: c.howTo })),
    coverage: richCoverage,
    suggestions
  };
}

// Exported (beyond the JSON-route-only usage below) so Task 12's SSR /posts
// route can reuse the exact same data shape/query pattern instead of
// duplicating it.
export async function buildPostsWithMetrics(env: Env): Promise<PostWithMetrics[]> {
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
  if (path === "/api/impact") return jsonOk(await buildImpact(env));
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
