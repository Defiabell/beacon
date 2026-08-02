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
});
