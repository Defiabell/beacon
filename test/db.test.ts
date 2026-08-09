import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import * as db from "../src/db";
import type { RepoDaily } from "../src/types";

const DB = env.DB;
const row = (over: Partial<RepoDaily> = {}): RepoDaily => ({
  repo: "Defiabell/shotsync", date: "2026-08-01",
  views: 10, uniqueViews: 5, clones: 2, uniqueClones: 2, stars: 3, forks: 1, ...over
});

describe("db", () => {
  it("upsertRepoDaily is idempotent and updates in place", async () => {
    await db.upsertRepoDaily(DB, [row()]);
    await db.upsertRepoDaily(DB, [row({ views: 20 })]);
    const series = await db.getRepoSeries(DB, "Defiabell/shotsync", 30);
    expect(series).toHaveLength(1);
    expect(series[0].views).toBe(20);
  });
  it("insertTodoIfNew dedupes on (project,source,title)", async () => {
    const t = { project: "shotsync", source: "audit" as const, title: "补 topics", priority: 1, status: "open" as const };
    await db.insertTodoIfNew(DB, t);
    await db.insertTodoIfNew(DB, t);
    expect(await db.listTodos(DB, "open")).toHaveLength(1);
  });
  it("insertPost rejects duplicate url", async () => {
    const p = { url: "https://www.v2ex.com/t/1229945", platform: "v2ex" as const, project: "nightide", title: "夜潮", publishedAt: null };
    await db.insertPost(DB, p);
    await expect(db.insertPost(DB, p)).rejects.toThrow();
  });
  it("replaceReferrerSnapshot replaces same-day rows", async () => {
    await db.replaceReferrerSnapshot(DB, "r", "2026-08-01", [{ referrer: "v2ex.com", count: 5, uniques: 4 }]);
    await db.replaceReferrerSnapshot(DB, "r", "2026-08-01", [{ referrer: "news.ycombinator.com", count: 9, uniques: 7 }]);
    const rows = await DB.prepare("select referrer from referrer_snapshot where repo='r'").all();
    expect(rows.results).toHaveLength(1);
  });
  it("upsertRepoDaily accepts an empty rows array without throwing", async () => {
    await db.upsertRepoDaily(DB, []);
  });
  it("getRepoSeries returns only the most recent `days` rows, ascending by date", async () => {
    await db.upsertRepoDaily(DB, [
      row({ repo: "Defiabell/days-limit", date: "2026-07-30", views: 1 }),
      row({ repo: "Defiabell/days-limit", date: "2026-07-31", views: 2 }),
      row({ repo: "Defiabell/days-limit", date: "2026-08-01", views: 3 })
    ]);
    const series = await db.getRepoSeries(DB, "Defiabell/days-limit", 2);
    expect(series.map(s => s.date)).toEqual(["2026-07-31", "2026-08-01"]);
  });

  // Coordinator review (2026-08-10): the /ui/channel matrix form (src/api/ui.ts)
  // has no way to supply a postId (only the JSON admin API's PUT /api/admin/channels
  // does), so it must never overwrite one that's already there — unlike
  // upsertProjectChannel, which unconditionally sets post_id to whatever it's
  // given (including null), by design, for the JSON API's own contract.
  describe("updateChannelStatus", () => {
    it("creates a fresh row with post_id null when none existed", async () => {
      await db.updateChannelStatus(DB, "nightide", "new-channel", "planned");
      const row2 = await DB.prepare("select status, post_id as postId from project_channels where project=?1 and channel_id=?2")
        .bind("nightide", "new-channel")
        .first<{ status: string; postId: number | null }>();
      expect(row2).toEqual({ status: "planned", postId: null });
    });

    it("updates only status, preserving an existing post_id set via the JSON admin path", async () => {
      await db.upsertProjectChannel(DB, "nightide", "v2ex", "posted", 42);
      await db.updateChannelStatus(DB, "nightide", "v2ex", "planned");
      const row2 = await DB.prepare("select status, post_id as postId from project_channels where project=?1 and channel_id=?2")
        .bind("nightide", "v2ex")
        .first<{ status: string; postId: number | null }>();
      expect(row2).toEqual({ status: "planned", postId: 42 });
    });
  });
});
