import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runDailyCollect } from "../src/collect/run";
import * as db from "../src/db";
import { CONFIG } from "../src/config";
import views from "./fixtures/gh-views.json";
import clones from "./fixtures/gh-clones.json";
import referrers from "./fixtures/gh-referrers.json";
import repoMeta from "./fixtures/gh-repo.json";
import hnFixture from "./fixtures/hn-item.json";

const FAILING_POST_URL = "https://www.v2ex.com/t/999999";
const OK_POST_URL = "https://news.ycombinator.com/item?id=39912345";

const stub: typeof fetch = async input => {
  const url = String(input);
  if (url.endsWith("/traffic/views")) return Response.json(views);
  if (url.endsWith("/traffic/clones")) return Response.json(clones);
  if (url.endsWith("/traffic/popular/referrers")) return Response.json(referrers);
  if (url.includes("/repos/")) return Response.json(repoMeta);
  if (url.includes("v2ex.com/api/topics/show.json")) return new Response("boom", { status: 500 });
  if (url.includes("hacker-news.firebaseio.com")) return Response.json(hnFixture);
  return new Response("not found", { status: 404 });
};

describe("runDailyCollect", () => {
  it("runs all 4 sources with per-source isolation", async () => {
    await db.insertPost(env.DB, {
      url: FAILING_POST_URL,
      platform: "v2ex",
      project: "nightide",
      title: "failing post",
      publishedAt: null
    });
    await db.insertPost(env.DB, {
      url: OK_POST_URL,
      platform: "hn",
      project: "nightide",
      title: "ok post",
      publishedAt: null
    });

    const reports = await runDailyCollect(env, new Date("2026-08-01T00:00:00Z"), stub);

    expect(reports.map(r => r.source).sort()).toEqual(["audit", "github", "goatcounter", "posts"]);

    const github = reports.find(r => r.source === "github")!;
    expect(github.ok).toBe(true);
    expect(github.error).toBeUndefined();

    const posts = reports.find(r => r.source === "posts")!;
    expect(posts.ok).toBe(false);
    expect(posts.error).toContain(FAILING_POST_URL);
    expect(posts.error).not.toContain(OK_POST_URL);

    const goatcounter = reports.find(r => r.source === "goatcounter")!;
    expect(goatcounter.ok).toBe(true);
    expect(goatcounter.error).toBe("not configured");

    const audit = reports.find(r => r.source === "audit")!;
    expect(audit.ok).toBe(true);
    expect(audit.error).toBeUndefined();

    // github: repo_daily rows landed for every configured project on the fixture dates
    for (const project of CONFIG.projects) {
      const series = await db.getRepoSeries(env.DB, project.repo, 30);
      expect(series.length).toBeGreaterThan(0);
      const today = series.find(r => r.date === "2026-08-01");
      expect(today).toBeDefined();
      expect(today!.stars).toBe(repoMeta.stargazers_count);
    }

    // github: star_history got a single row per project for "today"
    const starRow = await env.DB
      .prepare("select stars from star_history where repo=?1 and date=?2")
      .bind(CONFIG.projects[0].repo, "2026-08-01")
      .first<{ stars: number }>();
    expect(starRow?.stars).toBe(repoMeta.stargazers_count);

    // posts: the failing post has no metrics row, the ok post does
    const rows = await env.DB.prepare("select p.url as url, pm.date as date from posts p join post_metrics pm on pm.post_id = p.id").all<{ url: string; date: string }>();
    const urls = rows.results.map(r => r.url);
    expect(urls).toContain(OK_POST_URL);
    expect(urls).not.toContain(FAILING_POST_URL);

    // all 4 sources recorded in source_runs
    const sourceRuns = await db.listSourceRuns(env.DB);
    expect(sourceRuns.map(r => r.source).sort()).toEqual(["audit", "github", "goatcounter", "posts"]);
    const postsRun = sourceRuns.find(r => r.source === "posts")!;
    expect(postsRun.ok).toBe(false);
    expect(postsRun.error).toContain(FAILING_POST_URL);
  });
});
