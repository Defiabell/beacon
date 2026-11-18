import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as db from "../src/db";
import { CONFIG } from "../src/config";
import { buildTrends, buildSiteDetail, parseTrendWindow, windowDates } from "../src/api/trends";
import { buildOverview, type Overview } from "../src/api/public";
import { dayChart, growthText, niceTicks, windowDeltaPct } from "../src/ui/charts";
import { renderOverview, renderSite, renderTrends } from "../src/ui/pages";
import type { MetricCoverage } from "../src/metrics";

// A fixed "today" far from every other fixture, so the windows below contain
// only what each test seeds. The 7-day window is 03-03..03-09; the window
// before it is 02-24..03-02.
const TODAY = "2027-03-10";
const [A, B] = CONFIG.projects;

const repoRow = (repo: string, date: string, views: number, uniqueViews: number, clones: number) => ({
  repo, date, views, uniqueViews, clones, uniqueClones: clones, stars: 0, forks: 0
});

describe("windowDates / parseTrendWindow", () => {
  it("ends at yesterday: today's partial counts are never part of a window", () => {
    expect(windowDates("2027-03-10", 3)).toEqual(["2027-03-07", "2027-03-08", "2027-03-09"]);
  });

  it("accepts only the offered windows and falls back to 30 for anything else", () => {
    expect(parseTrendWindow("7")).toBe(7);
    expect(parseTrendWindow("90")).toBe(90);
    expect(parseTrendWindow(null)).toBe(30);
    expect(parseTrendWindow("8")).toBe(30);
    expect(parseTrendWindow("abc")).toBe(30);
  });
});

describe("buildTrends", () => {
  it("keeps an unrecorded day as null and a recorded zero as 0, and leaves today out", async () => {
    await db.upsertSiteDaily(env.DB, [
      { site: "a.test", date: "2027-03-08", pageviews: 0, visitors: 0 },
      { site: "a.test", date: "2027-03-09", pageviews: 5, visitors: 4 },
      { site: "a.test", date: TODAY, pageviews: 999, visitors: 999 },
      { site: "a.test", date: "2027-03-02", pageviews: 7, visitors: 6 }
    ]);
    const t = await buildTrends(env, 7, TODAY);
    expect(t.dates).toEqual(windowDates(TODAY, 7));
    expect(t.site.pageviews.values).toEqual([null, null, null, null, null, 0, 5]);
    expect(t.site.visits.values).toEqual([null, null, null, null, null, 0, 4]);
    // 03-02 is the last day of the previous window, not part of this one.
    expect(t.site.pageviews.previous).toEqual([null, null, null, null, null, null, 7]);
    expect(t.site.bySite.find(s => s.key === "a.test")).toMatchObject({ total: 5, values: [null, null, null, null, null, 0, 5] });
  });

  it("drops a stray host that is neither configured nor carrying traffic", async () => {
    await db.upsertSiteDaily(env.DB, [{ site: "stray.test", date: "2027-03-09", pageviews: 0, visitors: 0 }]);
    const t = await buildTrends(env, 7, TODAY);
    expect(t.site.bySite.some(s => s.key === "stray.test")).toBe(false);
  });

  it("sums only fleet repos, and counts a zero-visitor day's clones as machine, not human", async () => {
    await db.upsertRepoDaily(env.DB, [
      repoRow(A.repo, "2027-03-09", 10, 3, 2),
      repoRow(B.repo, "2027-03-09", 0, 0, 40),
      repoRow("someone/else", "2027-03-09", 500, 400, 300)
    ]);
    const t = await buildTrends(env, 7, TODAY);
    expect(t.repo.views.values.at(-1)).toBe(10);
    expect(t.repo.uniques.at(-1)).toBe(3);
    expect(t.repo.clones.values.at(-1)).toBe(2);
    expect(t.repo.machineClones.at(-1)).toBe(40);
    expect(t.repo.byRepo[0]).toMatchObject({ label: A.name, total: 10, href: `/p/${A.name}` });
  });

  it("carries a repo's last star count into the fleet total, but leaves a day with no snapshot at all as a gap", async () => {
    await db.upsertStarHistory(env.DB, A.repo, [{ date: "2027-03-07", stars: 10 }, { date: "2027-03-09", stars: 12 }]);
    // B was last snapshotted before the window; its 5 stars still exist on 03-07 and 03-09.
    await db.upsertStarHistory(env.DB, B.repo, [{ date: "2027-03-01", stars: 5 }]);
    const t = await buildTrends(env, 7, TODAY);
    expect(t.stars.total).toEqual([null, null, null, null, 15, null, 17]);
    expect(t.stars.latest).toBe(17);
    expect(t.stars.gained).toBe(2);
    expect(t.stars.byRepo.find(r => r.project === B.name)).toMatchObject({ latest: null, gained: null });
  });

  it("costs the same handful of D1 queries whatever the fleet size", async () => {
    let queries = 0;
    const counting = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    await buildTrends({ ...env, DB: counting }, 90, TODAY);
    expect(queries).toBe(5);
  });
});

// The overview used to issue 3 queries per project plus one per project for
// referrer peaks — 49 in all at ten projects, against a 50-query limit per
// invocation on the free plan. It must not creep back toward that.
describe("buildOverview query budget", () => {
  it("stays far below the per-invocation D1 query limit", async () => {
    let queries = 0;
    const counting = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => { queries++; return target.prepare(sql); };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    await buildOverview({ ...env, DB: counting });
    expect(queries).toBeLessThanOrEqual(20);
  });
});

describe("fleet-wide referrer readers", () => {
  it("getAllLatestReferrers takes each repo's own latest snapshot, not one global date", async () => {
    await db.replaceReferrerSnapshot(env.DB, "t/one", "2026-08-01", [{ referrer: "old.example", count: 9, uniques: 9 }]);
    await db.replaceReferrerSnapshot(env.DB, "t/one", "2026-08-03", [{ referrer: "new.example", count: 2, uniques: 1 }]);
    // t/two's collection stopped on 08-01: it must still be reported.
    await db.replaceReferrerSnapshot(env.DB, "t/two", "2026-08-01", [{ referrer: "only.example", count: 4, uniques: 3 }]);
    const rows = (await db.getAllLatestReferrers(env.DB)).filter(r => r.repo.startsWith("t/"));
    expect(rows).toEqual([
      { repo: "t/one", referrer: "new.example", count: 2, uniques: 1 },
      { repo: "t/two", referrer: "only.example", count: 4, uniques: 3 }
    ]);
  });

  it("getAllPeakReferrers agrees with the per-repo reader", async () => {
    await db.replaceReferrerSnapshot(env.DB, "t/peak", "2026-08-01", [{ referrer: "x.example", count: 3, uniques: 2 }]);
    await db.replaceReferrerSnapshot(env.DB, "t/peak", "2026-08-05", [{ referrer: "x.example", count: 8, uniques: 1 }]);
    const all = (await db.getAllPeakReferrers(env.DB)).filter(r => r.repo === "t/peak").map(({ repo: _repo, ...rest }) => rest);
    expect(all).toEqual(await db.getPeakReferrers(env.DB, "t/peak"));
    expect(all[0]).toMatchObject({ views: 8, uniques: 2, firstSeen: "2026-08-01", lastSeen: "2026-08-05" });
  });
});

describe("dayChart", () => {
  const dates = ["2027-03-07", "2027-03-08", "2027-03-09"];

  it("draws a missing day as a gap and a zero day as an empty slot — never the same thing", () => {
    const html = dayChart({ dates, values: [null, 0, 5], label: "浏览" });
    expect(html.match(/class="col miss/g)).toHaveLength(1);
    expect(html.match(/class="bar"/g)).toHaveLength(1);
    expect(html).toContain("无记录");
    // The zero day's readout says 0, in its own (non-missing) column.
    expect(html).toMatch(/class="col"><span class="tip"><span class="tip-date">03-08[^<]*<\/span><span class="tip-row"><b>0<\/b>/);
  });

  it("returns nothing when no day has a record, so the caller prints its empty state", () => {
    expect(dayChart({ dates, values: [null, null, null], label: "浏览" })).toBe("");
    expect(dayChart({ dates: [], values: [], label: "浏览" })).toBe("");
  });

  it("breaks a line at a missing day instead of bridging it", () => {
    const html = dayChart({ dates: [...dates, "2027-03-10"], values: [1, null, 3, 4], label: "star", kind: "line" });
    expect(html.match(/<polyline/g)).toHaveLength(2);
  });

  it("marks an event only on its own day, and escapes its title", () => {
    const html = dayChart({
      dates,
      values: [1, 2, 3],
      label: "views",
      markers: [{ date: "2027-03-08", label: "<b>发帖</b>" }, { date: "2020-01-01", label: "太久以前" }]
    });
    expect(html.match(/class="marker"/g)).toHaveLength(1);
    expect(html).not.toContain("<b>发帖</b>");
    expect(html).toContain("&lt;b&gt;发帖&lt;/b&gt;");
    expect(html).not.toContain("太久以前");
  });
});

describe("niceTicks", () => {
  it("never produces a fractional tick for a count, and always covers the maximum", () => {
    expect(niceTicks(0, 1)).toEqual([0, 1]);
    expect(niceTicks(0, 3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    for (const max of [7, 63, 504, 1584, 43677]) {
      const ticks = niceTicks(0, max);
      expect(ticks.every(Number.isInteger)).toBe(true);
      expect(ticks.at(-1)!).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeLessThanOrEqual(6);
    }
  });
});

describe("windowDeltaPct", () => {
  it("compares two fully recorded windows", () => {
    expect(windowDeltaPct([10, 20], [10, 10])).toBe(50);
  });

  it("refuses a comparison when either window has an unrecorded day or the baseline is zero", () => {
    expect(windowDeltaPct([10, null], [10, 10])).toBeNull();
    expect(windowDeltaPct([10, 20], [null, 10])).toBeNull();
    expect(windowDeltaPct([10, 20], [0, 0])).toBeNull();
  });
});

describe("renderOverview: tiles and folded rows", () => {
  const base: Overview = {
    projects: [], topTodos: [], suggestions: [], sources: [], sitePv7d: 0,
    surfaces: { surfaces: [], unclassified: [], since: null }, workers: [], sites: []
  };
  const dates = windowDates(TODAY, 14);

  it("prints no week-over-week change when the earlier week is not fully recorded", () => {
    const full = Array.from({ length: 14 }, () => 10);
    const holed = [null, ...full.slice(1)];
    const trend = { dates, sitePageviews: holed, siteVisits: full, repoViews: full, workerRequests: full, stars: 5, starsDelta7d: 1 };
    const html = renderOverview({ ...base, trend }, false);
    const tiles = html.split('class="tile"').slice(1);
    expect(tiles[0]).toContain("网站浏览");
    expect(tiles[0]).toContain('class="t-delta none"');
    expect(tiles[1]).toContain("网站访问");
    expect(tiles[1]).toContain('class="t-delta flat"');
  });

  it("folds quiet sites away, but never one whose collection failed", () => {
    const failed: MetricCoverage = { start: "2027-03-03", end: "2027-03-09", expectedDays: 7, observedDays: 0, lastDate: null, status: "failed" };
    const html = renderOverview({
      ...base,
      sites: [
        { site: "busy.test", pageviews: 40, visitors: 30, days: 7, lastDate: "2027-03-09" },
        { site: "broken.test", pageviews: null, visitors: null, days: 0, lastDate: null, coverage: failed },
        { site: "quiet.test", pageviews: 0, visitors: 0, days: 7, lastDate: "2027-03-09" }
      ]
    }, false);
    const [visible, folded] = html.split('<details class="fold"');
    expect(visible).toContain("busy.test");
    expect(visible).toContain("broken.test");
    expect(visible).toContain("采集失败");
    expect(visible).not.toContain("quiet.test");
    expect(folded).toContain("quiet.test");
  });
});

describe("/trends", () => {
  it("renders the page with the requested window selected and the table twin of the charts", async () => {
    await db.upsertSiteDaily(env.DB, [{ site: "a.test", date: windowDates(new Date().toISOString().slice(0, 10), 1)[0], pageviews: 12, visitors: 9 }]);
    const res = await SELF.fetch("https://beacon.internal/trends?days=7");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain('<a class="filter on" href="/trends?days=7">近 7 天</a>');
    expect(html).toContain("逐日明细 · 7 天");
    expect(html).toContain('<td class="num">12</td><td class="num">9</td>');
  });

  it("falls back to the 30-day window for an unsupported ?days=", async () => {
    const res = await SELF.fetch("https://beacon.internal/trends?days=5000");
    const html = await res.text();
    expect(html).toContain('<a class="filter on" href="/trends?days=30">近 30 天</a>');
  });

  it("GET /api/trends serves the same series as JSON", async () => {
    const res = await SELF.fetch("https://beacon.internal/api/trends?days=90");
    expect(res.status).toBe(200);
    const body = await res.json<{ days: number; dates: string[] }>();
    expect(body.days).toBe(90);
    expect(body.dates).toHaveLength(90);
  });

  it("shows an empty state instead of an empty plot when nothing is recorded", () => {
    const empty = Array.from({ length: 7 }, () => null);
    const html = renderTrends({
      days: 7,
      dates: windowDates(TODAY, 7),
      site: { pageviews: { values: empty, previous: empty }, visits: { values: empty, previous: empty }, bySite: [] },
      repo: { views: { values: empty, previous: empty }, uniques: empty, clones: { values: empty, previous: empty }, machineClones: empty, byRepo: [] },
      stars: { total: empty, latest: null, gained: null, byRepo: [] },
      workers: { requests: { values: empty, previous: empty }, errors: empty, byScript: [] },
      sources: []
    }, false);
    expect(html).toContain("这段时间没有任何站点访问记录。");
    expect(html).not.toContain('class="chart ');
  });
});

describe("growthText", () => {
  it("states a large rise as a multiple instead of a four-digit percentage", () => {
    expect(growthText(57)).toBe("57%");
    expect(growthText(-66)).toBe("66%");
    expect(growthText(199)).toBe("199%");
    expect(growthText(200)).toBe("3 倍");
    expect(growthText(1451)).toBe("15.5 倍");
    expect(growthText(20000)).toBe("201 倍");
  });
});

describe("renderOverview: freshness bar", () => {
  const base: Overview = {
    projects: [], topTodos: [], suggestions: [], sitePv7d: 0,
    surfaces: { surfaces: [], unclassified: [], since: null }, workers: [], sites: [],
    sources: [
      { source: "rum", lastRunAt: "2027-03-10 01:20:00", ok: true, error: null },
      { source: "goatcounter", lastRunAt: "2027-03-10 01:20:00", ok: true, error: "not configured" },
      { source: "posts", lastRunAt: "2027-03-10 01:10:00", ok: false, error: 'v2ex -> 403 "limited"' }
    ]
  };

  it("leaves out a source nobody configured, and puts a failed source's error on its mark", () => {
    const bar = renderOverview(base, false).match(/<p class="fresh">.*?<\/p>/s)![0];
    expect(bar).toContain("rum ✓");
    expect(bar).not.toContain("GoatCounter");
    expect(bar).toContain('<span title="v2ex -&gt; 403 &quot;limited&quot;">帖子 ✗</span>');
  });
});

describe("buildOverview: stars gained per day", () => {
  it("measures each day against the nearest earlier snapshot, and leaves an unsnapshotted day unknown", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [d1, d2, d3] = windowDates(today, 3);
    await db.upsertStarHistory(env.DB, A.repo, [{ date: d1, stars: 10 }, { date: d3, stars: 12 }]);
    const o = await buildOverview(env);
    expect(o.trend!.dates.slice(-3)).toEqual([d1, d2, d3]);
    expect(o.trend!.starsGained!.slice(-2)).toEqual([null, 2]);
  });
});

describe("site page", () => {
  const seed = async () => {
    await db.upsertSiteDaily(env.DB, [
      { site: "spike.test", date: "2027-03-08", pageviews: 100, visitors: 60 },
      { site: "spike.test", date: "2027-03-09", pageviews: 4, visitors: 4 }
    ]);
    await db.upsertSiteReferrerDaily(env.DB, [
      { site: "spike.test", date: "2027-03-08", referrer: "www.v2ex.com", pageviews: 30, visits: 30 },
      { site: "spike.test", date: "2027-03-08", referrer: "global.v2ex.co", pageviews: 5, visits: 5 },
      { site: "spike.test", date: "2027-03-08", referrer: "unknown.example", pageviews: 2, visits: 1 },
      // A referrer row on a day the site itself has no row: not a "0 pageviews, 9 referred" day.
      { site: "spike.test", date: "2027-03-05", referrer: "www.v2ex.com", pageviews: 9, visits: 9 }
    ]);
  };

  it("lines each day's pageviews up with where they came from", async () => {
    await seed();
    const d = (await buildSiteDetail(env, "Spike.Test", 7, TODAY))!;
    expect(d.host).toBe("spike.test");
    expect(d.firstDate).toBe("2027-03-08");
    expect(d.pageviews.values).toEqual([null, null, null, null, null, 100, 4]);
    // 03-05 has referrer rows but no site row; 03-09 is recorded with nothing referred.
    expect(d.referred).toEqual([null, null, null, null, null, 37, 0]);
    expect(d.referrers.map(r => [r.referrer, r.pageviews, r.surface])).toEqual([
      ["www.v2ex.com", 39, "community"],
      ["global.v2ex.co", 5, "community"],
      ["unknown.example", 2, null]
    ]);
  });

  it("is a 404 for a host that is neither configured nor ever recorded, and for anything that is not a hostname", async () => {
    expect(await buildSiteDetail(env, "never-seen.example", 7, TODAY)).toBeNull();
    expect(await buildSiteDetail(env, "a b<script>", 7, TODAY)).toBeNull();
    const res = await SELF.fetch("https://beacon.internal/s/never-seen.example");
    expect(res.status).toBe(404);
  });

  it("still renders a configured host that has no rows yet", async () => {
    const host = CONFIG.sites[0].host;
    const d = (await buildSiteDetail(env, host, 7, TODAY))!;
    expect(d.firstDate).toBeNull();
    expect(renderSite(d, false)).toContain("这段时间没有访问记录。");
  });

  it("puts the day's top referrers in that day's hover readout, escaped", async () => {
    await seed();
    await db.upsertSiteReferrerDaily(env.DB, [{ site: "spike.test", date: "2027-03-08", referrer: "<b>x</b>.example", pageviews: 50, visits: 50 }]);
    const html = renderSite((await buildSiteDetail(env, "spike.test", 7, TODAY))!, false);
    expect(html).toContain('<span class="tip-note first">&lt;b&gt;x&lt;/b&gt;.example 50</span><span class="tip-note">www.v2ex.com 30</span>');
    expect(html).toContain('<span class="tip-note">另有 1 个来源</span>');
    expect(html).not.toContain("<b>x</b>");
  });

  it("GET /s/:host and /api/site/:host serve a recorded site", async () => {
    const yesterday = windowDates(new Date().toISOString().slice(0, 10), 1)[0];
    await db.upsertSiteDaily(env.DB, [{ site: "live.test", date: yesterday, pageviews: 3, visitors: 2 }]);
    const page = await SELF.fetch("https://beacon.internal/s/live.test?days=7");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<a class="filter on" href="/s/live.test?days=7">近 7 天</a>');
    const api = await SELF.fetch("https://beacon.internal/api/site/live.test?days=7");
    expect((await api.json<{ pageviews: { values: (number | null)[] } }>()).pageviews.values.at(-1)).toBe(3);
  });
});
