import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import * as db from "../src/db";
import { CONFIG } from "../src/config";
import { handlePublicApi, buildImpact, buildProjectDetail, buildMatrix } from "../src/api/public";
import type { EventImpact } from "../src/impact/attribute";

const SHOTSYNC = CONFIG.projects.find(p => p.name === "shotsync")!;
const NIGHTIDE = CONFIG.projects.find(p => p.name === "nightide")!;

function repoRow(repo: string, date: string, views: number, uniqueViews: number, clones: number) {
  return { repo, date, views, uniqueViews, clones, uniqueClones: clones, stars: 0, forks: 0 };
}

function call(method: string, url: string): Promise<Response | null> {
  const request = new Request(`https://beacon.internal${url}`, { method });
  return handlePublicApi(request, env, new URL(request.url).pathname);
}

// Production-shaped fixture (design doc §1 / task acceptance criterion),
// written through the real DB write paths (insertPost/upsertRepoDaily/
// upsertStarHistory) rather than constructed as plain objects — this proves
// the full DB -> buildEvents -> computeImpact vertical slice, not just the
// pure function in isolation (already covered by test/attribute.test.ts).
// publishedAt is explicit on every post so these dates never depend on the
// real wall-clock time the test happens to run at.
beforeAll(async () => {
  await db.upsertRepoDaily(env.DB, [
    repoRow(SHOTSYNC.repo, "2026-08-02", 2, 2, 0),
    repoRow(SHOTSYNC.repo, "2026-08-03", 4, 4, 0),
    repoRow(SHOTSYNC.repo, "2026-08-04", 1, 1, 0),
    repoRow(SHOTSYNC.repo, "2026-08-05", 6, 5, 0),
    repoRow(SHOTSYNC.repo, "2026-08-06", 0, 0, 0),
    repoRow(SHOTSYNC.repo, "2026-08-07", 3, 3, 0),
    repoRow(SHOTSYNC.repo, "2026-08-08", 5, 4, 0),
    repoRow(SHOTSYNC.repo, "2026-08-09", 3, 3, 0),
    repoRow(SHOTSYNC.repo, "2026-08-10", 26, 20, 0)
  ]);
  await db.upsertStarHistory(env.DB, SHOTSYNC.repo, [
    { date: "2026-08-01", stars: 0 },
    { date: "2026-08-08", stars: 0 },
    { date: "2026-08-10", stars: 2 }
  ]);
  await db.insertPost(env.DB, {
    url: "https://www.v2ex.com/t/1229945",
    platform: "v2ex",
    project: SHOTSYNC.name,
    title: "shotsync 分享创造",
    publishedAt: "2026-08-09"
  });

  const nightideRows = [
    ["2026-07-20", 5, 5], ["2026-07-21", 6, 6], ["2026-07-22", 4, 4], ["2026-07-23", 5, 5],
    ["2026-07-24", 7, 6], ["2026-07-25", 5, 5], ["2026-07-26", 6, 6], ["2026-07-27", 6, 6],
    ["2026-07-28", 5, 5], ["2026-07-29", 5, 5], ["2026-07-30", 6, 6], ["2026-07-31", 4, 4],
    ["2026-08-01", 6, 6], ["2026-08-02", 5, 5]
  ] as const;
  await db.upsertRepoDaily(env.DB, nightideRows.map(([date, views, uv]) => repoRow(NIGHTIDE.repo, date, views, uv, 0)));
  await db.upsertStarHistory(env.DB, NIGHTIDE.repo, [{ date: "2026-07-01", stars: 100 }]);
  await db.insertPost(env.DB, {
    url: "https://www.v2ex.com/t/9990001",
    platform: "v2ex",
    project: NIGHTIDE.name,
    title: "夜潮上线",
    publishedAt: "2026-07-27"
  });
});

describe("buildImpact (acceptance criterion, through the real DB)", () => {
  it("surfaces shotsync's 08-09 post as a positive, honestly-flagged-collecting signal, and nightide's 07-27 post as near-zero", async () => {
    const impacts = await buildImpact(env);
    const shotsync = impacts.find(i => i.event.project === "shotsync" && i.event.date === "2026-08-09")!;
    expect(shotsync).toBeDefined();
    expect(shotsync.status).toBe("collecting");
    expect(shotsync.after.days).toBe(2);
    expect(shotsync.before.views).toBe(21);
    expect(shotsync.after.views).toBe(29);
    expect(shotsync.after.starsDelta).toBe(2);
    expect(shotsync.after.views / shotsync.after.days).toBeGreaterThan(shotsync.before.views / shotsync.before.days);

    const nightide = impacts.find(i => i.event.project === "nightide" && i.event.date === "2026-07-27")!;
    expect(nightide).toBeDefined();
    expect(nightide.status).toBe("complete");
    expect(Math.abs(nightide.after.views - nightide.before.views)).toBeLessThanOrEqual(2);
    expect(nightide.after.starsDelta).toBe(0);
  });

  it("never represents the shotsync after-window's partial numbers as a final, complete result", () => {
    // Re-assert the honesty invariant explicitly at the API-surface level (not
    // just the pure engine): status must accompany the numbers so a caller
    // physically cannot render 29 views as "final" without also seeing
    // "collecting" + days=2 right next to it.
    return buildImpact(env).then(impacts => {
      const shotsync = impacts.find(i => i.event.project === "shotsync")!;
      expect(shotsync.status).not.toBe("complete");
      expect(shotsync.after.days).toBeLessThan(7);
    });
  });
});

describe("GET /api/impact", () => {
  it("200s with the same data buildImpact returns, and the standard public Cache-Control", async () => {
    const res = await call("GET", "/api/impact");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res!.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=600");
    const body = await res!.json<EventImpact[]>();
    expect(body.some(i => i.event.project === "shotsync")).toBe(true);
  });
});

describe("buildProjectDetail: events field", () => {
  it("scopes events to the requested project only", async () => {
    const detail = await buildProjectDetail(env, "shotsync");
    expect(detail).not.toBeNull();
    expect(detail!.events).toHaveLength(1);
    expect(detail!.events![0].event.project).toBe("shotsync");
    expect(detail!.events![0].after.views).toBe(29);

    const nightideDetail = await buildProjectDetail(env, "nightide");
    expect(nightideDetail!.events!.every(e => e.event.project === "nightide")).toBe(true);
  });

  it("a project with no posts/todos gets an empty events array, not a crash", async () => {
    const detail = await buildProjectDetail(env, "day-monitor");
    expect(detail).not.toBeNull();
    expect(detail!.events).toEqual([]);
  });
});

describe("buildMatrix: coverage[].effect", () => {
  it("attaches an effect summary only to a posted channel with a postId link", async () => {
    const posts = await db.listPostsForImpact(env.DB);
    const shotsyncPost = posts.find(p => p.project === "shotsync")!;
    await db.upsertProjectChannel(env.DB, "shotsync", "v2ex", "posted", shotsyncPost.id);
    // A posted channel with NO postId link (set via the no-JS /ui/channel form,
    // which never supplies one) — must show the checkmark but no effect chip.
    await db.upsertProjectChannel(env.DB, "shotsync", "linuxdo", "posted", null);

    const matrix = await buildMatrix(env);
    const v2exRow = matrix.coverage.find(c => c.project === "shotsync" && c.channelId === "v2ex")!;
    const linuxdoRow = matrix.coverage.find(c => c.project === "shotsync" && c.channelId === "linuxdo")!;

    expect(v2exRow.effect).toBeDefined();
    expect(v2exRow.effect!.views).toBe(29);
    expect(v2exRow.effect!.starsDelta).toBe(2);
    expect(v2exRow.effect!.status).toBe("collecting");
    expect(v2exRow.effect!.days).toBe(2);

    expect(linuxdoRow.effect).toBeUndefined();
  });
});

// The scenario that motivated referrer-backed attribution, reproduced through
// the real DB: three self-submissions filed on the same day, for the same
// project, inside the same spike. The window arithmetic cannot tell them apart
// — it gives all three identical numbers — and only one of them caused
// anything. Before this, the page credited each of them with the whole wave.
describe("buildImpact: referrer-backed attribution", () => {
  const YIXI = CONFIG.projects.find(p => p.name === "yixi")!;

  beforeAll(async () => {
    const quiet = ["2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];
    const loud = ["2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
    await db.upsertRepoDaily(env.DB, [
      ...quiet.map(d => repoRow(YIXI.repo, d, 2, 2, 0)),
      ...loud.map(d => repoRow(YIXI.repo, d, 100, 80, 0))
    ]);
    await db.upsertStarHistory(env.DB, YIXI.repo, [
      { date: "2026-09-04", stars: 5 },
      { date: "2026-09-11", stars: 45 }
    ]);

    // Coverage starts 09-01, before the posts — so a zero reading below means
    // "referred nobody", not "we were not watching" (ReferredTraffic.predatesCoverage).
    await db.replaceReferrerSnapshot(env.DB, YIXI.repo, "2026-09-01", [
      { referrer: "github.com", count: 10, uniques: 8 }
    ]);
    // Only 阮一峰周刊 ever published. HelloGitHub's host never appears.
    await db.replaceReferrerSnapshot(env.DB, YIXI.repo, "2026-09-12", [
      { referrer: "ruanyifeng.com", count: 369, uniques: 227 },
      { referrer: "github.com", count: 184, uniques: 96 }
    ]);

    for (const [url, title] of [
      ["https://github.com/ruanyf/weekly/issues/11509", "一息 · 周刊自荐"],
      ["https://github.com/521xueweihan/HelloGitHub/issues/3642", "一息 · HelloGitHub 自荐"],
      ["https://github.com/GitHubDaily/GitHubDaily/issues/1067", "一息 · GitHubDaily 自荐"]
    ] as const) {
      await db.insertPost(env.DB, { url, platform: "github", project: YIXI.name, title, publishedAt: "2026-09-05" });
    }
  });

  it("gives three same-day submissions identical windows but three different verdicts", async () => {
    const impacts = await buildImpact(env);
    const byTitle = (t: string) => impacts.find(i => i.event.title === t)!;
    const ruanyf = byTitle("一息 · 周刊自荐");
    const hello = byTitle("一息 · HelloGitHub 自荐");
    const daily = byTitle("一息 · GitHubDaily 自荐");

    // The window numbers really are the same for all three — that is the trap.
    for (const i of [hello, daily]) {
      expect(i.after.views).toBe(ruanyf.after.views);
      expect(i.after.starsDelta).toBe(ruanyf.after.starsDelta);
    }
    expect(ruanyf.after.views).toBe(700);
    expect(ruanyf.after.starsDelta).toBe(40);

    // 阮一峰周刊 published: its host is in the referrers, so it earns the credit.
    expect(ruanyf.attribution!.verdict).toBe("referred");
    expect(ruanyf.attribution!.channelId).toBe("ruanyf-weekly");
    expect(ruanyf.attribution!.views).toBe(369);

    // HelloGitHub is observable and referred nobody — not the same as unknown.
    expect(hello.attribution!.verdict).toBe("no-referral");
    expect(hello.attribution!.channelId).toBe("hellogithub");
    expect(hello.attribution!.views).toBe(0);

    // GitHubDaily publishes off-web, so there is nothing to observe either way.
    expect(daily.attribution!.verdict).toBe("unobservable");
    expect(daily.attribution!.channelId).toBe("githubdaily");
  });

  it("marks finished todos as non-distribution events", async () => {
    const impacts = await buildImpact(env);
    const todos = impacts.filter(i => i.event.kind === "todo");
    expect(todos.every(i => i.attribution!.verdict === "not-a-channel")).toBe(true);
  });

  it("flags a post that predates referrer coverage instead of reading it as zero", async () => {
    const impacts = await buildImpact(env);
    // nightide's V2EX post (2026-07-27) sits before any referrer snapshot for
    // that repo — the real case that ReferredTraffic.predatesCoverage exists for.
    const nightidePost = impacts.find(i => i.event.project === "nightide" && i.event.kind === "post")!;
    expect(nightidePost.attribution!.verdict).toBe("predates-coverage");
  });
});
