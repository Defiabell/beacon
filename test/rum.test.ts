import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { buildQuery, normalizeRum, fetchRumDaily } from "../src/collect/rum";
import { upsertSiteDaily, getSiteTotals } from "../src/db";
import { CONFIG, type SiteConfig } from "../src/config";

const SITES: SiteConfig[] = [
  { name: "博客", host: "defiabell.github.io", siteTag: "679daf9b94fa433aa14020d7a40caf1b" },
  { name: "mythmesh", host: "mythmesh.pages.dev", siteTag: "79f96ab6a4fb4226affa009174c939ff" }
];

// Shaped from a live query run on 2026-08-30, so the mapping is pinned to the
// real API rather than to a guess about it.
const REAL_SHAPE = {
  data: {
    viewer: {
      accounts: [
        {
          s0: [{ count: 41, sum: { visits: 5 }, dimensions: { date: "2026-08-30" } }],
          s1: [{ count: 2, sum: { visits: 2 }, dimensions: { date: "2026-08-30" } }]
        }
      ]
    }
  }
};

describe("buildQuery", () => {
  it("emits one alias per site so the whole fleet costs a single request", () => {
    const q = buildQuery(SITES);
    expect(q).toContain("s0: rumPageloadEventsAdaptiveGroups");
    expect(q).toContain("s1: rumPageloadEventsAdaptiveGroups");
    expect(q).toContain(SITES[0].siteTag);
    expect(q).toContain(SITES[1].siteTag);
  });

  it("refuses a siteTag that isn't a plain hex id instead of escaping it", () => {
    // The tag is concatenated into the query string, so a malformed one is
    // rejected outright rather than trusted.
    const bad = [{ name: "x", host: "x.test", siteTag: '"} evil {' }] as SiteConfig[];
    expect(() => buildQuery(bad)).toThrow(/invalid siteTag/);
  });

  it("every configured site has a usable tag", () => {
    expect(() => buildQuery(CONFIG.sites)).not.toThrow();
  });
});

describe("normalizeRum", () => {
  it("maps the live response shape, keying each alias back to its host", () => {
    expect(normalizeRum(REAL_SHAPE, SITES)).toEqual([
      { site: "defiabell.github.io", date: "2026-08-30", pageviews: 41, visitors: 5 },
      { site: "mythmesh.pages.dev", date: "2026-08-30", pageviews: 2, visitors: 2 }
    ]);
  });

  it("drops a row with no date rather than storing it under a placeholder", () => {
    const rows = normalizeRum(
      { data: { viewer: { accounts: [{ s0: [{ count: 9, sum: { visits: 1 }, dimensions: {} }] }] } } },
      [SITES[0]]
    );
    expect(rows).toEqual([]);
  });

  it("defaults missing counts to 0 rather than NaN", () => {
    const rows = normalizeRum(
      { data: { viewer: { accounts: [{ s0: [{ dimensions: { date: "2026-08-30" } }] }] } } },
      [SITES[0]]
    );
    expect(rows).toEqual([{ site: "defiabell.github.io", date: "2026-08-30", pageviews: 0, visitors: 0 }]);
  });

  it("returns [] for every malformed envelope rather than throwing", () => {
    for (const bad of [null, undefined, 7, "no", {}, { data: {} }, { data: { viewer: { accounts: [] } } }]) {
      expect(normalizeRum(bad, SITES)).toEqual([]);
    }
  });
});

describe("fetchRumDaily", () => {
  it("throws on a GraphQL errors array instead of recording zero traffic", async () => {
    // A token without analytics permission answers HTTP 200 with `errors`.
    // Reading that as "no rows" would write a silent 0 for every site.
    const stub: typeof fetch = async () => Response.json({ errors: [{ message: "Authentication error" }] });
    await expect(fetchRumDaily(SITES, "acc", "tok", "2026-08-28", "2026-08-30", stub)).rejects.toThrow(/Authentication error/);
  });

  it("throws on a non-2xx response", async () => {
    const stub: typeof fetch = async () => new Response("nope", { status: 403 });
    await expect(fetchRumDaily(SITES, "acc", "tok", "2026-08-28", "2026-08-30", stub)).rejects.toThrow(/403/);
  });

  it("makes no request at all when no sites are configured", async () => {
    let called = 0;
    const stub: typeof fetch = async () => { called++; return Response.json(REAL_SHAPE); };
    expect(await fetchRumDaily([], "acc", "tok", "2026-08-28", "2026-08-30", stub)).toEqual([]);
    expect(called).toBe(0);
  });
});

describe("site_daily storage", () => {
  it("upserts so a restated day corrects rather than duplicates", async () => {
    await upsertSiteDaily(env.DB, [{ site: "a.test", date: "2026-08-29", pageviews: 10, visitors: 2 }]);
    await upsertSiteDaily(env.DB, [{ site: "a.test", date: "2026-08-29", pageviews: 17, visitors: 3 }]);
    const row = await env.DB.prepare("select pageviews, visitors from site_daily where site='a.test' and date='2026-08-29'")
      .first<{ pageviews: number; visitors: number }>();
    expect(row).toEqual({ pageviews: 17, visitors: 3 });
  });

  it("totals a trailing window measured from the newest row, not from today", async () => {
    await upsertSiteDaily(env.DB, [
      { site: "busy.test", date: "2026-02-10", pageviews: 100, visitors: 10 },
      { site: "busy.test", date: "2026-02-09", pageviews: 50, visitors: 5 },
      { site: "busy.test", date: "2026-02-01", pageviews: 999, visitors: 99 }, // outside a 7-day window
      { site: "quiet.test", date: "2026-02-10", pageviews: 3, visitors: 1 }
    ]);
    const totals = await getSiteTotals(env.DB, 7);
    const busy = totals.find(t => t.site === "busy.test")!;
    expect(busy.pageviews).toBe(150); // 2026-02-01 excluded
    expect(busy.visitors).toBe(15);
    expect(busy.lastDate).toBe("2026-02-10");
    // Busiest first.
    expect(totals.findIndex(t => t.site === "busy.test")).toBeLessThan(totals.findIndex(t => t.site === "quiet.test"));
  });
});
