import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import * as db from "../src/db";
import type { RepoDaily } from "../src/types";
import migration0002 from "../migrations/0002_posts_created_at.sql?raw";

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
  // Task: posts.created_at (migration 0002) — the impact engine (src/impact/)
  // needs a timestamp on every post even when published_at is NULL.
  describe("posts.created_at", () => {
    it("insertPost writes created_at explicitly, as an ISO timestamp, without it being part of the Post param", async () => {
      const before = Date.now();
      const id = await db.insertPost(DB, {
        url: "https://www.v2ex.com/t/9000001",
        platform: "v2ex",
        project: "shotsync",
        title: "created_at coverage",
        publishedAt: null
      });
      const row2 = await DB.prepare("select created_at as createdAt from posts where id=?1").bind(id).first<{ createdAt: string }>();
      expect(row2?.createdAt).toBeTruthy();
      expect(row2!.createdAt).not.toBe("");
      // ISO 8601, e.g. 2026-08-11T03:04:05.123Z — new Date().toISOString(), not SQLite's datetime('now').
      expect(row2!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(row2!.createdAt)).toBeGreaterThanOrEqual(before);
    });

    // The ALTER TABLE half of migration 0002 already ran once, before any test
    // in this file inserted a row (see test/apply-migrations.ts) — replaying
    // the whole file would fail on "duplicate column name". So this extracts
    // and replays just the backfill UPDATE statement, against a row manually
    // put into the pre-migration shape (created_at = '' placeholder), to
    // verify that exact statement's COALESCE logic.
    it("migration 0002's backfill statement fills created_at from published_at, or a fixed fallback when published_at is also NULL", async () => {
      const backfillSql = migration0002
        .split(";")
        .map(s => s.trim())
        .find(s => s.startsWith("UPDATE posts SET created_at"));
      expect(backfillSql).toBeTruthy();

      const withPublished = await DB.prepare(
        `insert into posts (url, platform, project, title, published_at, created_at) values ('https://backfill.test/1','v2ex','nightide','has date','2026-07-27','') returning id`
      ).first<{ id: number }>();
      const withoutPublished = await DB.prepare(
        `insert into posts (url, platform, project, title, published_at, created_at) values ('https://backfill.test/2','v2ex','nightide','no date',NULL,'') returning id`
      ).first<{ id: number }>();

      await DB.prepare(backfillSql!).run();

      const row2 = await DB.prepare("select created_at as createdAt from posts where id=?1").bind(withPublished!.id).first<{ createdAt: string }>();
      const row3 = await DB.prepare("select created_at as createdAt from posts where id=?1").bind(withoutPublished!.id).first<{ createdAt: string }>();
      expect(row2?.createdAt).toBe("2026-07-27"); // COALESCE prefers published_at
      expect(row3?.createdAt).toBe("2026-08-09"); // fixed fallback when published_at is also NULL
    });
  });

  describe("getAllRepoDaily", () => {
    it("returns every row for a repo, ascending by date, with no `days` limit", async () => {
      const repo = "Defiabell/all-repo-daily";
      await db.upsertRepoDaily(DB, [
        { repo, date: "2026-06-01", views: 1, uniqueViews: 1, clones: 0, uniqueClones: 0, stars: 0, forks: 0 },
        { repo, date: "2026-08-01", views: 3, uniqueViews: 1, clones: 0, uniqueClones: 0, stars: 0, forks: 0 },
        { repo, date: "2026-07-01", views: 2, uniqueViews: 1, clones: 0, uniqueClones: 0, stars: 0, forks: 0 }
      ]);
      const all = await db.getAllRepoDaily(DB, repo);
      expect(all.map(r => r.date)).toEqual(["2026-06-01", "2026-07-01", "2026-08-01"]);
    });

    it("returns [] for a repo with no rows, without throwing", async () => {
      expect(await db.getAllRepoDaily(DB, "Defiabell/no-such-repo")).toEqual([]);
    });
  });

  describe("listPostsForImpact", () => {
    it("returns every post's id/project/platform/title/url/publishedAt/createdAt", async () => {
      const id = await db.insertPost(DB, {
        url: "https://www.v2ex.com/t/9000002",
        platform: "v2ex",
        project: "shotsync",
        title: "impact listing coverage",
        publishedAt: "2026-08-09"
      });
      const rows = await db.listPostsForImpact(DB);
      const row2 = rows.find(r => r.id === id);
      expect(row2).toMatchObject({
        id,
        project: "shotsync",
        platform: "v2ex",
        title: "impact listing coverage",
        url: "https://www.v2ex.com/t/9000002",
        publishedAt: "2026-08-09"
      });
      expect(row2!.createdAt).toBeTruthy();
    });
  });

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
