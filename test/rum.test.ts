import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { buildQuery, normalizeRum, fetchRumDaily, buildReferrerQuery, normalizeRumReferrers, fetchRumReferrers } from "../src/collect/rum";
import { upsertSiteDaily, getSiteTotals, upsertSiteReferrerDaily, getSiteReferrerTotals, getSiteReferrerDaily, getSiteReferrerSince } from "../src/db";
import { CONFIG, siteFor, siteHosts, type SiteConfig } from "../src/config";

const SITES: SiteConfig[] = [
  { name: "博客", host: "defiabell.github.io", siteTag: "679daf9b94fa433aa14020d7a40caf1b" },
  { name: "mythmesh", host: "mythmesh.pages.dev", siteTag: "79f96ab6a4fb4226affa009174c939ff" }
];

// A zone-level site: one tag auto-injected on every host under defiabell.com.
const ZONE: SiteConfig = {
  name: "defiabell.com（全域）", host: "defiabell.com", siteTag: "2f684bb019964ffda60ebf040fcb010a",
  hosts: ["defiabell.com", "gulliver.defiabell.com"]
};

// Shaped from a live query run on 2026-10-26 against the zone-level site.
const ZONE_SHAPE = {
  data: {
    viewer: {
      accounts: [
        {
          s0: [
            { count: 70, sum: { visits: 70 }, dimensions: { date: "2026-10-20", requestHost: "gulliver.defiabell.com" } },
            { count: 20, sum: { visits: 20 }, dimensions: { date: "2026-10-20", requestHost: "defiabell.com" } },
            { count: 10, sum: { visits: 10 }, dimensions: { date: "2026-10-21", requestHost: "Geshuo.defiabell.com" } }
          ]
        }
      ]
    }
  }
};

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

  it("asks for requestHost only on a zone-level alias", () => {
    const q = buildQuery([SITES[0], ZONE]);
    const [, s0, s1] = q.split(/s\d: /);
    expect(s0).not.toContain("requestHost");
    expect(s1).toContain("dimensions{date requestHost}");
    // hosts × days rows need more room than one hostname's days.
    expect(s1).toContain("limit:1000");
  });
});

describe("zone-level site config", () => {
  it("expands to its listed hosts for zero-filling, a plain site to itself", () => {
    expect(siteHosts(ZONE)).toEqual(["defiabell.com", "gulliver.defiabell.com"]);
    expect(siteHosts(SITES[0])).toEqual(["defiabell.github.io"]);
  });

  it("claims the apex, listed hosts and unlisted subdomains, but not lookalikes", () => {
    const sites = [SITES[0], ZONE];
    expect(siteFor(sites, "defiabell.com")).toBe(ZONE);
    expect(siteFor(sites, "gulliver.defiabell.com")).toBe(ZONE);
    expect(siteFor(sites, "www.defiabell.com")).toBe(ZONE); // unlisted subdomain still belongs to the zone
    expect(siteFor(sites, "defiabell.github.io")).toBe(SITES[0]);
    expect(siteFor(sites, "notdefiabell.com")).toBeUndefined();
    expect(siteFor(sites, "defiabell.pages.dev")).toBeUndefined();
  });

  it("the live config's zone entry covers every project homepage on the domain", () => {
    const zone = CONFIG.sites.find(s => s.host === "defiabell.com")!;
    expect(zone.hosts).toBeDefined();
    for (const p of CONFIG.projects) {
      const home = p.homepage ? new URL(p.homepage).host : null;
      if (home && home.endsWith("defiabell.com")) expect(zone.hosts).toContain(home);
    }
  });
});

describe("normalizeRum", () => {
  it("maps the live response shape, keying each alias back to its host", () => {
    expect(normalizeRum(REAL_SHAPE, SITES)).toEqual([
      { site: "defiabell.github.io", date: "2026-08-30", pageviews: 41, visitors: 5 },
      { site: "mythmesh.pages.dev", date: "2026-08-30", pageviews: 2, visitors: 2 }
    ]);
  });

  it("splits a zone-level site by requestHost, lower-cased, one site_daily row per host", () => {
    expect(normalizeRum(ZONE_SHAPE, [ZONE])).toEqual([
      { site: "gulliver.defiabell.com", date: "2026-10-20", pageviews: 70, visitors: 70 },
      { site: "defiabell.com", date: "2026-10-20", pageviews: 20, visitors: 20 },
      { site: "geshuo.defiabell.com", date: "2026-10-21", pageviews: 10, visitors: 10 }
    ]);
  });

  it("drops a zone row with an empty or missing requestHost instead of crediting the apex", () => {
    const rows = normalizeRum(
      { data: { viewer: { accounts: [{ s0: [
        { count: 9, sum: { visits: 1 }, dimensions: { date: "2026-10-20", requestHost: "" } },
        { count: 9, sum: { visits: 1 }, dimensions: { date: "2026-10-20" } }
      ] }] } } },
      [ZONE]
    );
    expect(rows).toEqual([]);
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

  it("rejects a zone-level response that lacks the requestHost dimension", async () => {
    // Would mean the query lost its host dimension: every host's traffic would
    // otherwise collapse into whatever normalizeRum did with it.
    const stub: typeof fetch = async () => Response.json(REAL_SHAPE);
    await expect(fetchRumDaily([ZONE], "acc", "tok", "2026-10-20", "2026-10-22", stub)).rejects.toThrow(/invalid daily data/);
  });

  it("accepts a zone-level response and returns one row per host", async () => {
    const stub: typeof fetch = async () => Response.json(ZONE_SHAPE);
    const rows = await fetchRumDaily([ZONE], "acc", "tok", "2026-10-20", "2026-10-22", stub);
    expect(rows.map(r => r.site)).toEqual(["gulliver.defiabell.com", "defiabell.com", "geshuo.defiabell.com"]);
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

  it("totals a fixed calendar window ending yesterday", async () => {
    await upsertSiteDaily(env.DB, [
      { site: "busy.test", date: "2026-02-10", pageviews: 100, visitors: 10 },
      { site: "busy.test", date: "2026-02-09", pageviews: 50, visitors: 5 },
      { site: "busy.test", date: "2026-02-01", pageviews: 999, visitors: 99 }, // outside a 7-day window
      { site: "quiet.test", date: "2026-02-10", pageviews: 3, visitors: 1 }
    ]);
    const totals = await getSiteTotals(env.DB, 7, "2026-02-11");
    const busy = totals.find(t => t.site === "busy.test")!;
    expect(busy.pageviews).toBe(150); // 2026-02-01 excluded
    expect(busy.visitors).toBe(15);
    expect(busy.lastDate).toBe("2026-02-10");
    // Busiest first.
    expect(totals.findIndex(t => t.site === "busy.test")).toBeLessThan(totals.findIndex(t => t.site === "quiet.test"));
  });
});

// Shaped from a live query run on 2026-11-01 against the zone-level site:
// self-referrals carry visits:0, external referrers carry visits == count,
// and the odd row has a refererPath.
const ZONE_REFERRER_SHAPE = {
  data: {
    viewer: {
      accounts: [
        {
          s0: [
            { count: 763, sum: { visits: 0 }, dimensions: { date: "2026-10-27", refererHost: "kaogu.defiabell.com", refererPath: "/", requestHost: "kaogu.defiabell.com" } },
            { count: 69, sum: { visits: 69 }, dimensions: { date: "2026-10-27", refererHost: "", refererPath: "", requestHost: "kaogu.defiabell.com" } },
            { count: 11, sum: { visits: 11 }, dimensions: { date: "2026-10-27", refererHost: "www.v2ex.com", refererPath: "/t/1252234", requestHost: "kaogu.defiabell.com" } },
            { count: 4, sum: { visits: 4 }, dimensions: { date: "2026-10-27", refererHost: "bing.com", refererPath: "/", requestHost: "kaogu.defiabell.com" } },
            { count: 2, sum: { visits: 2 }, dimensions: { date: "2026-10-27", refererHost: "www.bing.com", refererPath: "/copilotsearch", requestHost: "kaogu.defiabell.com" } },
            { count: 3, sum: { visits: 3 }, dimensions: { date: "2026-10-27", refererHost: "chatgpt.com", refererPath: "/", requestHost: "kaogu.defiabell.com" } },
            { count: 2, sum: { visits: 2 }, dimensions: { date: "2026-10-26", refererHost: "lost.defiabell.com", refererPath: "/", requestHost: "defiabell.com" } },
            { count: 1, sum: { visits: 1 }, dimensions: { date: "2026-10-26", refererHost: "ChatGPT.com", refererPath: "", requestHost: "Kaogu.defiabell.com" } }
          ]
        }
      ]
    }
  }
};

describe("buildReferrerQuery", () => {
  it("asks for refererHost and refererPath on every alias, requestHost only on a zone", () => {
    const q = buildReferrerQuery([SITES[0], ZONE]);
    const [, s0, s1] = q.split(/s\d: /);
    expect(s0).toContain("dimensions{date refererHost refererPath}");
    expect(s1).toContain("dimensions{date refererHost refererPath requestHost}");
    expect(q).toContain(SITES[0].siteTag);
    expect(q).toContain(ZONE.siteTag);
  });

  it("refuses a malformed siteTag like buildQuery does", () => {
    expect(() => buildReferrerQuery([{ name: "x", host: "x.test", siteTag: "nope" }])).toThrow(/invalid siteTag/);
  });
});

describe("normalizeRumReferrers", () => {
  it("keeps external referrers only, splits a zone by requestHost, and folds path labels", () => {
    const rows = normalizeRumReferrers(ZONE_REFERRER_SHAPE, [ZONE]);
    const kaogu = rows.filter(r => r.site === "kaogu.defiabell.com" && r.date === "2026-10-27");
    // In-site navigation (kaogu -> kaogu) and direct arrivals (empty host) are
    // not referrals and are dropped.
    expect(kaogu.map(r => r.referrer).sort()).toEqual(["bing.com", "bing.com/copilotsearch", "chatgpt.com", "www.v2ex.com"]);
    expect(kaogu.find(r => r.referrer === "bing.com/copilotsearch")).toEqual({ site: "kaogu.defiabell.com", date: "2026-10-27", referrer: "bing.com/copilotsearch", pageviews: 2, visits: 2 });
    expect(kaogu.find(r => r.referrer === "bing.com")!.pageviews).toBe(4);
    // Cross-host but still ours: an arrival, stored and later classified "own".
    expect(rows).toContainEqual({ site: "defiabell.com", date: "2026-10-26", referrer: "lost.defiabell.com", pageviews: 2, visits: 2 });
    // Hosts are lower-cased on both sides of the key.
    expect(rows).toContainEqual({ site: "kaogu.defiabell.com", date: "2026-10-26", referrer: "chatgpt.com", pageviews: 1, visits: 1 });
  });

  it("sums raw rows that fold into the same label", () => {
    const payload = { data: { viewer: { accounts: [{ s0: [
      { count: 2, sum: { visits: 2 }, dimensions: { date: "2026-10-27", refererHost: "x.com", refererPath: "/i/grok?x=1" } },
      { count: 3, sum: { visits: 1 }, dimensions: { date: "2026-10-27", refererHost: "x.com", refererPath: "/i/grok/share" } },
      { count: 5, sum: { visits: 5 }, dimensions: { date: "2026-10-27", refererHost: "x.com", refererPath: "/" } }
    ] }] } } };
    expect(normalizeRumReferrers(payload, [SITES[0]])).toEqual([
      { site: "defiabell.github.io", date: "2026-10-27", referrer: "x.com/i/grok", pageviews: 5, visits: 3 },
      { site: "defiabell.github.io", date: "2026-10-27", referrer: "x.com", pageviews: 5, visits: 5 }
    ]);
  });

  it("returns [] for every malformed envelope rather than throwing", () => {
    for (const bad of [null, undefined, 7, "no", {}, { data: {} }, { data: { viewer: { accounts: [] } } }]) {
      expect(normalizeRumReferrers(bad, SITES)).toEqual([]);
    }
  });
});

describe("fetchRumReferrers", () => {
  it("throws on a GraphQL errors array and on a missing alias instead of recording no referrals", async () => {
    const denied: typeof fetch = async () => Response.json({ errors: [{ message: "Authentication error" }] });
    await expect(fetchRumReferrers(SITES, "acc", "tok", "2026-10-25", "2026-10-27", denied)).rejects.toThrow(/Authentication error/);
    const partial: typeof fetch = async () => Response.json({ data: { viewer: { accounts: [{ s0: [] }] } } });
    await expect(fetchRumReferrers(SITES, "acc", "tok", "2026-10-25", "2026-10-27", partial)).rejects.toThrow(/missing account or site data/);
  });

  it("makes no request when no sites are configured", async () => {
    let called = 0;
    const stub: typeof fetch = async () => { called++; return Response.json({}); };
    expect(await fetchRumReferrers([], "acc", "tok", "2026-10-25", "2026-10-27", stub)).toEqual([]);
    expect(called).toBe(0);
  });
});

describe("site_referrer_daily storage", () => {
  it("upserts per (site, date, referrer), totals a window, lists a site's days newest first, and knows its first day", async () => {
    expect(await getSiteReferrerSince(env.DB)).toBeNull();
    await upsertSiteReferrerDaily(env.DB, [
      { site: "r.test", date: "2026-03-01", referrer: "chatgpt.com", pageviews: 1, visits: 1 },
      { site: "r.test", date: "2026-03-02", referrer: "chatgpt.com", pageviews: 2, visits: 2 },
      { site: "r.test", date: "2026-03-02", referrer: "v2ex.com", pageviews: 9, visits: 8 },
      { site: "r.test", date: "2026-02-01", referrer: "chatgpt.com", pageviews: 50, visits: 50 } // outside the window
    ]);
    await upsertSiteReferrerDaily(env.DB, [{ site: "r.test", date: "2026-03-02", referrer: "chatgpt.com", pageviews: 3, visits: 3 }]);
    const totals = await getSiteReferrerTotals(env.DB, 7, "2026-03-03");
    expect(totals.filter(t => t.site === "r.test")).toEqual([
      { site: "r.test", referrer: "v2ex.com", pageviews: 9, visits: 8 },
      { site: "r.test", referrer: "chatgpt.com", pageviews: 4, visits: 4 }
    ]);
    const daily = await getSiteReferrerDaily(env.DB, "r.test", 7, "2026-03-03");
    expect(daily.map(d => `${d.date} ${d.referrer} ${d.pageviews}`)).toEqual([
      "2026-03-02 v2ex.com 9",
      "2026-03-02 chatgpt.com 3",
      "2026-03-01 chatgpt.com 1"
    ]);
    expect(await getSiteReferrerSince(env.DB)).toBe("2026-02-01");
  });
});
