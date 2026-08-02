import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import * as db from "../src/db";
import { CONFIG } from "../src/config";
import { CHANNELS, suggestPairs } from "../src/channels";
import {
  handlePublicApi,
  type Overview,
  type ProjectDetail,
  type MatrixData,
  type PostWithMetrics
} from "../src/api/public";
import type { Todo, SourceRun } from "../src/types";

const NIGHTIDE = CONFIG.projects.find(p => p.name === "nightide")!;
const DAY_MONITOR = CONFIG.projects.find(p => p.name === "day-monitor")!;

function call(method: string, url: string): Promise<Response | null> {
  const request = new Request(`https://beacon.internal${url}`, { method });
  return handlePublicApi(request, env, new URL(request.url).pathname);
}

async function seedTodo(opts: {
  project: string;
  source: "audit" | "matrix" | "manual";
  title: string;
  priority: number;
  status: "open" | "done";
  createdAt: string;
}): Promise<number> {
  const res = await env.DB.prepare(
    `insert into todos (project, source, title, priority, status, created_at) values (?1,?2,?3,?4,?5,?6)`
  )
    .bind(opts.project, opts.source, opts.title, opts.priority, opts.status, opts.createdAt)
    .run();
  return res.meta.last_row_id;
}

function repoRow(repo: string, date: string, views: number, clones: number) {
  return { repo, date, views, uniqueViews: views, clones, uniqueClones: clones, stars: 0, forks: 0 };
}

// Everything except site_daily is seeded once here — site_daily is seeded
// later, inside the "sitePv7d" describe below, specifically so an earlier
// test in that describe can assert the empty-table (0) branch first. Every
// other describe block in this file leaves site_daily untouched, so that
// ordering constraint is local to that one describe.
beforeAll(async () => {
  // repo_daily: 3 days each for nightide + day-monitor; shotsync/screen-coach
  // get none, to exercise the "no data yet" defaults.
  await db.upsertRepoDaily(env.DB, [
    repoRow(NIGHTIDE.repo, "2026-07-30", 10, 1),
    repoRow(NIGHTIDE.repo, "2026-07-31", 15, 2),
    repoRow(NIGHTIDE.repo, "2026-08-01", 20, 3)
  ]);
  await db.upsertRepoDaily(env.DB, [
    repoRow(DAY_MONITOR.repo, "2026-07-30", 5, 0),
    repoRow(DAY_MONITOR.repo, "2026-07-31", 7, 1),
    repoRow(DAY_MONITOR.repo, "2026-08-01", 9, 1)
  ]);

  // star_history: nightide spans >7 days with no exact row at the 7-days-back
  // target date, exercising "nearest-before" baseline selection. day-monitor
  // spans <7 days entirely, exercising "fewer than 7 days -> earliest row".
  await db.upsertStarHistory(env.DB, NIGHTIDE.repo, [
    { date: "2026-07-20", stars: 100 },
    { date: "2026-07-25", stars: 120 },
    { date: "2026-07-27", stars: 139 },
    { date: "2026-07-30", stars: 150 },
    { date: "2026-08-01", stars: 160 },
    { date: "2026-08-04", stars: 170 }
  ]);
  await db.upsertStarHistory(env.DB, DAY_MONITOR.repo, [
    { date: "2026-08-01", stars: 50 },
    { date: "2026-08-02", stars: 55 },
    { date: "2026-08-04", stars: 60 }
  ]);

  // referrer_snapshot: nightide has an older captured_date that must NOT
  // appear, and a latest date with 6 rows (to exercise the top-5 slice vs.
  // the full list). day-monitor gets none at all (exercises the empty path).
  await db.replaceReferrerSnapshot(env.DB, NIGHTIDE.repo, "2026-07-30", [
    { referrer: "old.com", count: 999, uniques: 900 }
  ]);
  await db.replaceReferrerSnapshot(env.DB, NIGHTIDE.repo, "2026-08-01", [
    { referrer: "google.com", count: 50, uniques: 40 },
    { referrer: "twitter.com", count: 30, uniques: 25 },
    { referrer: "reddit.com", count: 20, uniques: 15 },
    { referrer: "news.ycombinator.com", count: 10, uniques: 8 },
    { referrer: "other1.com", count: 5, uniques: 4 },
    { referrer: "other2.com", count: 3, uniques: 2 }
  ]);

  // posts: one for nightide with two metrics dates (latest must win), one for
  // a different project (shotsync) to prove cross-project isolation and that
  // /api/posts aggregates across every project.
  const nightidePostId = await db.insertPost(env.DB, {
    url: "https://www.v2ex.com/t/1111",
    platform: "v2ex",
    project: "nightide",
    title: "夜潮发布",
    publishedAt: null
  });
  await db.upsertPostMetrics(env.DB, nightidePostId, "2026-07-30", { views: 80, replies: 3, likes: 5, score: 10 });
  await db.upsertPostMetrics(env.DB, nightidePostId, "2026-08-01", { views: 100, replies: 5, likes: 10, score: 20 });

  const shotsyncPostId = await db.insertPost(env.DB, {
    url: "https://www.v2ex.com/t/2222",
    platform: "v2ex",
    project: "shotsync",
    title: "shotsync 发布",
    publishedAt: null
  });
  await db.upsertPostMetrics(env.DB, shotsyncPostId, "2026-08-01", { views: 40, replies: 1, likes: 2, score: 4 });

  // audit_results: one row for nightide, to verify field mapping in project detail.
  await db.upsertAuditResults(
    env.DB,
    "nightide",
    [{ checkId: "topics", status: "fail", detail: "2 topic(s)", priority: 1 }],
    "2026-08-01T00:00:00Z"
  );

  // todos: mixed priority/status/project, with explicit created_at (bypassing
  // insertTodoIfNew's datetime('now')) so priority-then-created_at ordering is
  // deterministic to assert against.
  await seedTodo({ project: "nightide", source: "manual", title: "t1", priority: 1, status: "open", createdAt: "2026-07-01T00:00:00Z" });
  await seedTodo({ project: "nightide", source: "manual", title: "t2", priority: 1, status: "open", createdAt: "2026-07-02T00:00:00Z" });
  await seedTodo({ project: "nightide", source: "manual", title: "t7", priority: 2, status: "open", createdAt: "2026-06-01T00:00:00Z" });
  await seedTodo({ project: "day-monitor", source: "manual", title: "t3", priority: 2, status: "open", createdAt: "2026-07-01T00:00:00Z" });
  await seedTodo({ project: "day-monitor", source: "manual", title: "t4", priority: 2, status: "open", createdAt: "2026-07-03T00:00:00Z" });
  await seedTodo({ project: "shotsync", source: "manual", title: "t5", priority: 3, status: "open", createdAt: "2026-07-01T00:00:00Z" });
  await seedTodo({ project: "screen-coach", source: "manual", title: "t6", priority: 3, status: "open", createdAt: "2026-07-02T00:00:00Z" });
  await seedTodo({ project: "nightide", source: "manual", title: "d1", priority: 1, status: "done", createdAt: "2026-06-15T00:00:00Z" });
  await seedTodo({ project: "shotsync", source: "manual", title: "d2", priority: 2, status: "done", createdAt: "2026-06-16T00:00:00Z" });

  // project_channels: exactly one posted coverage row.
  await db.upsertProjectChannel(env.DB, "nightide", "v2ex", "posted", null);

  // source_runs, for /api/health.
  await db.recordSourceRun(env.DB, "github", true);
  await db.recordSourceRun(env.DB, "posts", false, "boom");
});

describe("GET /api/overview", () => {
  it("computes exact per-project numbers, including empty-history defaults", async () => {
    const res = await call("GET", "/api/overview");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json<Overview>();
    expect(body.projects).toHaveLength(CONFIG.projects.length);

    const nightide = body.projects.find(p => p.project === "nightide")!;
    expect(nightide.repo).toBe(NIGHTIDE.repo);
    expect(nightide.stars).toBe(170);
    expect(nightide.starsDelta7d).toBe(31); // 170 - 139 (nearest-before-target baseline, 07-27)
    expect(nightide.views14d).toBe(45); // 10+15+20
    expect(nightide.clones14d).toBe(6); // 1+2+3
    expect(nightide.postCount).toBe(1);
    expect(nightide.topReferrers.map(r => r.referrer)).toEqual([
      "google.com",
      "twitter.com",
      "reddit.com",
      "news.ycombinator.com",
      "other1.com"
    ]); // top 5 by count; "old.com" (older snapshot) and "other2.com" (6th) excluded

    const dayMonitor = body.projects.find(p => p.project === "day-monitor")!;
    expect(dayMonitor.stars).toBe(60);
    expect(dayMonitor.starsDelta7d).toBe(10); // 60 - 50, fewer than 7 days of history -> earliest row
    expect(dayMonitor.views14d).toBe(21); // 5+7+9
    expect(dayMonitor.clones14d).toBe(2); // 0+1+1
    expect(dayMonitor.topReferrers).toEqual([]); // no referrer_snapshot rows at all

    const untouched = body.projects.find(p => p.project === "screen-coach")!;
    expect(untouched.stars).toBe(0);
    expect(untouched.starsDelta7d).toBe(0);
    expect(untouched.views14d).toBe(0);
    expect(untouched.clones14d).toBe(0);
    expect(untouched.postCount).toBe(0);
    expect(untouched.topReferrers).toEqual([]);
  });

  it("topTodos: top 5 open todos ordered priority asc then created_at asc", async () => {
    const res = await call("GET", "/api/overview");
    const body = await res!.json<Overview>();
    expect(body.topTodos.map(t => t.title)).toEqual(["t1", "t2", "t7", "t3", "t4"]);
    expect(body.topTodos.every(t => t.status === "open")).toBe(true);
  });

  it("suggestions: delegates to suggestPairs with the seeded coverage, excluding the posted pairing", async () => {
    const res = await call("GET", "/api/overview");
    const body = await res!.json<Overview>();
    const expected = suggestPairs(CONFIG.projects, [{ project: "nightide", channelId: "v2ex", status: "posted" }]);
    expect(body.suggestions).toEqual(expected);
    expect(body.suggestions.some(s => s.project === "nightide" && s.channelId === "v2ex")).toBe(false);
  });

  it("sources: reflects source_runs", async () => {
    const res = await call("GET", "/api/overview");
    const body = await res!.json<Overview>();
    const bySource = Object.fromEntries(body.sources.map(s => [s.source, s]));
    expect(bySource.github.ok).toBe(true);
    expect(bySource.posts.ok).toBe(false);
    expect(bySource.posts.error).toBe("boom");
  });
});

describe("GET /api/project/:name", () => {
  it("returns full detail for a known project", async () => {
    const res = await call("GET", "/api/project/nightide");
    expect(res!.status).toBe(200);
    const body = await res!.json<ProjectDetail>();

    expect(body.summary.project).toBe("nightide");
    expect(body.summary.stars).toBe(170);
    expect(body.summary.views14d).toBe(45);
    expect(body.summary.clones14d).toBe(6);
    expect(body.summary.topReferrers).toHaveLength(5);

    expect(body.repoSeries.map(r => r.date)).toEqual(["2026-07-30", "2026-07-31", "2026-08-01"]);
    expect(body.starSeries).toEqual([
      { date: "2026-07-20", stars: 100 },
      { date: "2026-07-25", stars: 120 },
      { date: "2026-07-27", stars: 139 },
      { date: "2026-07-30", stars: 150 },
      { date: "2026-08-01", stars: 160 },
      { date: "2026-08-04", stars: 170 }
    ]);

    // full latest-snapshot referrer list (6 rows), not the top-5-sliced summary field
    expect(body.referrers).toHaveLength(6);
    expect(body.referrers.map(r => r.referrer)).toContain("other2.com");

    expect(body.posts).toHaveLength(1);
    expect(body.posts[0].post.url).toBe("https://www.v2ex.com/t/1111");
    expect(body.posts[0].latest).toEqual({ date: "2026-08-01", views: 100, replies: 5, likes: 10, score: 20 });

    expect(body.audit).toEqual([
      { checkId: "topics", status: "fail", detail: "2 topic(s)", priority: 1, checkedAt: "2026-08-01T00:00:00Z" }
    ]);
  });

  it("404s for an unknown project", async () => {
    const res = await call("GET", "/api/project/does-not-exist");
    expect(res!.status).toBe(404);
  });
});

describe("GET /api/todos", () => {
  it("defaults to status=open", async () => {
    const res = await call("GET", "/api/todos");
    const body = await res!.json<Todo[]>();
    expect(body).toHaveLength(7);
    expect(body.every(t => t.status === "open")).toBe(true);
  });

  it("filters to status=done", async () => {
    const res = await call("GET", "/api/todos?status=done");
    const body = await res!.json<Todo[]>();
    expect(body.map(t => t.title).sort()).toEqual(["d1", "d2"]);
    expect(body.every(t => t.status === "done")).toBe(true);
  });
});

describe("GET /api/matrix", () => {
  it("returns projects, channels, coverage, and suggestions", async () => {
    const res = await call("GET", "/api/matrix");
    const body = await res!.json<MatrixData>();
    expect(body.projects).toEqual(CONFIG.projects.map(p => p.name));
    expect(body.channels).toHaveLength(CHANNELS.length);
    expect(body.channels[0]).toEqual({ id: CHANNELS[0].id, name: CHANNELS[0].name, lang: CHANNELS[0].lang });
    expect(body.coverage).toEqual([{ project: "nightide", channelId: "v2ex", status: "posted" }]);
    expect(body.suggestions.some(s => s.project === "nightide" && s.channelId === "v2ex")).toBe(false);
  });
});

describe("GET /api/posts", () => {
  it("returns every post across all projects with latest metrics", async () => {
    const res = await call("GET", "/api/posts");
    const body = await res!.json<PostWithMetrics[]>();
    expect(body).toHaveLength(2);
    const byProject = Object.fromEntries(body.map(p => [p.post.project, p]));
    expect(byProject.nightide.latest?.views).toBe(100);
    expect(byProject.shotsync.latest?.views).toBe(40);
  });
});

describe("GET /api/health", () => {
  it("returns source_runs", async () => {
    const res = await call("GET", "/api/health");
    const body = await res!.json<SourceRun[]>();
    const bySource = Object.fromEntries(body.map(s => [s.source, s]));
    expect(bySource.github.ok).toBe(true);
    expect(bySource.posts.ok).toBe(false);
    expect(bySource.posts.error).toBe("boom");
  });
});

describe("response headers on every 200", () => {
  const cases: [string, string][] = [
    ["GET", "/api/overview"],
    ["GET", "/api/matrix"],
    ["GET", "/api/posts"],
    ["GET", "/api/health"],
    ["GET", "/api/todos"],
    ["GET", "/api/project/nightide"]
  ];

  it.each(cases)("%s %s carries Cache-Control + Content-Type", async (method, path) => {
    const res = await call(method, path);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res!.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=600");
  });
});

describe("routing edge cases", () => {
  it("returns null for a path with no /api/ prefix", async () => {
    expect(await call("GET", "/nope")).toBeNull();
  });

  it("returns null for /api/admin/* regardless of method, leaving it to handleAdmin", async () => {
    // This ordering (admin-prefix check before the method check) is load-bearing:
    // a POST to an admin path must fall through to handleAdmin, not be intercepted
    // and 405'd here as if it were an unrecognized public route.
    expect(await call("GET", "/api/admin/x")).toBeNull();
    expect(await call("POST", "/api/admin/collect")).toBeNull();
  });

  it("404s an unrecognized /api/ path", async () => {
    const res = await call("GET", "/api/nope");
    expect(res!.status).toBe(404);
  });

  it("405s a non-GET method on a known public route, without cache headers", async () => {
    const res = await call("POST", "/api/overview");
    expect(res!.status).toBe(405);
    expect(res!.headers.get("Cache-Control")).toBeNull();
  });
});

describe("sitePv7d", () => {
  it("is 0 when site_daily has no rows yet", async () => {
    const res = await call("GET", "/api/overview");
    const body = await res!.json<Overview>();
    expect(body.sitePv7d).toBe(0);
  });

  it("sums pageviews over only the 7 most recently recorded dates", async () => {
    const rows: [string, number][] = [
      ["2026-07-24", 100],
      ["2026-07-25", 101],
      ["2026-07-26", 102],
      ["2026-07-27", 103],
      ["2026-07-28", 104],
      ["2026-07-29", 105],
      ["2026-07-30", 106],
      ["2026-07-31", 107],
      ["2026-08-01", 108],
      ["2026-08-02", 109]
    ];
    await db.upsertSiteDaily(
      env.DB,
      rows.map(([date, pageviews]) => ({ site: "defiabell", date, pageviews, visitors: 0 }))
    );

    const res = await call("GET", "/api/overview");
    const body = await res!.json<Overview>();
    // most recent 7 dates: 07-27..08-02 -> 103+104+105+106+107+108+109 = 742
    // (07-24/25/26 = 100+101+102 = 303 must be excluded)
    expect(body.sitePv7d).toBe(742);
  });
});
