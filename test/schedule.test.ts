import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { AUDIT_CRONS, COLLECT_CRON, scheduledCollection } from "../src/schedule";
import { runDailyCollect } from "../src/collect/run";
import { CONFIG } from "../src/config";
import { insertPost, listSourceRuns } from "../src/db";

const day = new Date("2026-09-18T01:00:00Z");
const analyticEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" };

function budgetedFetch() {
  let requests = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    if (++requests > 50) throw new Error("Too many subrequests");
    const url = String(input);
    if (url.endsWith("/traffic/views")) return Response.json({ views: [] });
    if (url.endsWith("/traffic/clones")) return Response.json({ clones: [] });
    if (url.endsWith("/traffic/popular/referrers")) return Response.json([]);
    if (url.startsWith("https://api.github.com/repos/")) return Response.json({ stargazers_count: 7, forks_count: 1 });
    if (url.includes("hacker-news.firebaseio.com")) return Response.json({ score: 1, descendants: 0 });
    if (url.includes("/pages/projects")) return Response.json({ success: true, result: [] });
    if (url.includes("/graphql")) {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      const account = query.includes("rumPageloadEventsAdaptiveGroups")
        ? Object.fromEntries(CONFIG.sites.map((_, i) => [`s${i}`, []]))
        : query.includes("pagesFunctionsInvocationsAdaptiveGroups")
          ? { pagesFunctionsInvocationsAdaptiveGroups: [] }
          : { workersInvocationsAdaptive: [] };
      return Response.json({ data: { viewer: { accounts: [account] } } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { fetchFn, requests: () => requests };
}

describe("scheduled collection budgets", () => {
  it("routes every daily group and both audit shards explicitly", () => {
    expect([0, 10, 20].map(minute => scheduledCollection(COLLECT_CRON, +day + minute * 60000).sources))
      .toEqual([["github"], ["posts"], ["goatcounter", "cloudflare", "pages", "rum"]]);
    AUDIT_CRONS.forEach((cron, auditShard) => {
      expect(scheduledCollection(cron, +day)).toEqual({ sources: ["audit"], auditShard });
    });
    expect(() => scheduledCollection("0 1 * * *", +day)).toThrow("Unknown collection schedule");
    expect(() => scheduledCollection(COLLECT_CRON, +day + 60000)).toThrow("Unknown collection schedule");
  });

  it("collects the current fleet and 12 posts without starving analytics", async () => {
    for (let i = 0; i < 12; i++) {
      await insertPost(env.DB, { url: `https://news.ycombinator.com/item?id=${i}`, platform: "hn", project: "shotsync", title: `Post ${i}`, publishedAt: null });
    }
    const combined = budgetedFetch();
    const failed = await runDailyCollect(analyticEnv, day, combined.fetchFn, ["github", "posts", "cloudflare", "pages", "rum"]);
    expect(failed.find(report => report.source === "rum")?.error).toContain("Too many subrequests");

    const counts: number[] = [];
    for (const minute of [0, 10, 20]) {
      const budget = budgetedFetch();
      const { sources } = scheduledCollection(COLLECT_CRON, +day + minute * 60000);
      const reports = await runDailyCollect(analyticEnv, day, budget.fetchFn, sources);
      expect(reports.every(report => report.ok)).toBe(true);
      counts.push(budget.requests());
    }
    expect(counts).toEqual([CONFIG.projects.length * 4, 12, 4]);
    expect(counts.every(count => count <= 40)).toBe(true);
    const health = await listSourceRuns(env.DB);
    expect(health.find(row => row.source === "rum")?.ok).toBe(true);
    const rum = await env.DB.prepare("SELECT date,pageviews FROM site_daily WHERE site=? ORDER BY date")
      .bind(CONFIG.sites[0].host).all<{ date: string; pageviews: number }>();
    expect(rum.results).toEqual([15, 16, 17].map(day => ({ date: `2026-09-${day}`, pageviews: 0 })));
    const github = await env.DB.prepare("SELECT date,views FROM repo_daily WHERE repo=? ORDER BY date")
      .bind(CONFIG.projects[0].repo).all<{ date: string; views: number }>();
    expect(github.results).toHaveLength(14);
    expect(github.results[0]).toEqual({ date: "2026-09-05", views: 0 });
    expect(github.results[13]).toEqual({ date: "2026-09-18", views: 0 });
  });

  it("preserves measured GitHub boundary buckets without inventing older zeroes", async () => {
    const regular = budgetedFetch();
    const fetchFn: typeof fetch = async (input, init) => String(input).endsWith("/traffic/views")
      ? Response.json({ views: [{ timestamp: "2026-09-04T00:00:00Z", count: 9, uniques: 4 }] })
      : regular.fetchFn(input, init);
    const reports = await runDailyCollect(env, day, fetchFn, ["github"]);
    expect(reports[0].ok).toBe(true);
    const rows = await env.DB.prepare("SELECT date,views FROM repo_daily WHERE repo=? ORDER BY date")
      .bind(CONFIG.projects[0].repo).all<{ date: string; views: number }>();
    expect(rows.results).toHaveLength(15);
    expect(rows.results[0]).toEqual({ date: "2026-09-04", views: 9 });
    expect(rows.results[1]).toEqual({ date: "2026-09-05", views: 0 });
  });

  it("queries GoatCounter for complete days without fabricating rows", async () => {
    let requested: URL | undefined;
    const fetchFn: typeof fetch = async input => { requested = new URL(String(input)); return Response.json({ stats: [] }); };
    const reports = await runDailyCollect({ ...env, GOATCOUNTER_SITE: "test", GOATCOUNTER_TOKEN: "token" }, day, fetchFn, ["goatcounter"]);
    expect(reports[0].ok).toBe(true);
    expect(requested?.searchParams.get("start")).toBe("2026-09-15");
    expect(requested?.searchParams.get("end")).toBe("2026-09-17");
    const row = await env.DB.prepare("SELECT count(*) AS n FROM site_daily").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("fetches complete UTC analytics days and fills only known Functions scripts", async () => {
    const requestDates: { start: string; end: string }[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).includes("/pages/projects")) return Response.json({ success: true, result: [
        { name: "app", subdomain: "app.pages.dev", production_script_name: "pages-worker--1-production" },
        { name: "static", subdomain: "static.pages.dev", production_script_name: "pages-worker--2-production" }
      ] });
      const { query, variables } = JSON.parse(String(init?.body));
      requestDates.push({ start: variables.start, end: variables.end });
      const account = query.includes("pagesFunctionsInvocationsAdaptiveGroups")
        ? { pagesFunctionsInvocationsAdaptiveGroups: [{ dimensions: { scriptName: "pages-worker--1-production", date: "2026-09-16" }, sum: { requests: 4, errors: 0 } }] }
        : { workersInvocationsAdaptive: [] };
      return Response.json({ data: { viewer: { accounts: [account] } } });
    };
    const reports = await runDailyCollect(analyticEnv, day, fetchFn, ["cloudflare", "pages"]);
    expect(reports.every(report => report.ok)).toBe(true);
    expect(requestDates).toEqual(Array(2).fill({ start: "2026-09-15", end: "2026-09-17" }));
    const rows = await env.DB.prepare("SELECT script,date,requests FROM worker_daily ORDER BY date").all();
    expect(rows.results).toEqual([15, 16, 17].map(date => ({ script: "app.pages.dev", date: `2026-09-${date}`, requests: date === 16 ? 4 : 0 })));
  });

  it("does not turn a failed or malformed RUM response into zero traffic", async () => {
    for (const response of [Response.json({ errors: [{ message: "denied" }] }), Response.json({ data: { viewer: { accounts: [{}] } } })]) {
      const reports = await runDailyCollect(analyticEnv, day, async () => response, ["rum"]);
      expect(reports[0].ok).toBe(false);
    }
    const result = await env.DB.prepare("SELECT count(*) AS n FROM site_daily").first<{ n: number }>();
    expect(result?.n).toBe(0);
  });
});
