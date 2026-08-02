import { describe, it, expect } from "vitest";
import { normalizeTotal, fetchSiteDaily } from "../src/collect/goatcounter";
import fixture from "./fixtures/goatcounter-total.json";

describe("normalizeTotal", () => {
  it("maps stats entries to SiteDaily[], defaulting visitors to 0 when daily_unique is absent", () => {
    const rows = normalizeTotal(fixture, "defiabell");
    expect(rows).toEqual([
      { site: "defiabell", date: "2026-07-30", pageviews: 12, visitors: 8 },
      { site: "defiabell", date: "2026-07-31", pageviews: 20, visitors: 15 },
      { site: "defiabell", date: "2026-08-01", pageviews: 34, visitors: 0 }
    ]);
  });

  it("returns [] when stats array is missing", () => {
    expect(normalizeTotal({ total: 1, total_events: 1 }, "defiabell")).toEqual([]);
  });

  it("returns [] for malformed/non-object payloads", () => {
    expect(normalizeTotal(null, "defiabell")).toEqual([]);
    expect(normalizeTotal(undefined, "defiabell")).toEqual([]);
    expect(normalizeTotal("not json", "defiabell")).toEqual([]);
    expect(normalizeTotal({ stats: "not an array" }, "defiabell")).toEqual([]);
  });

  it("skips individual malformed entries within an otherwise valid stats array", () => {
    const rows = normalizeTotal({ stats: [{ day: "2026-07-30", daily: 5 }, { foo: "bar" }, null] }, "defiabell");
    expect(rows).toEqual([{ site: "defiabell", date: "2026-07-30", pageviews: 5, visitors: 0 }]);
  });
});

describe("fetchSiteDaily", () => {
  it("sends Bearer auth + UA header and start/end query params, then normalizes the response", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const stub: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Response.json(fixture);
    };
    const rows = await fetchSiteDaily("defiabell", "tok", "2026-07-30", "2026-08-01", stub);
    expect(capturedUrl).toBe(
      "https://defiabell.goatcounter.com/api/v0/stats/total?start=2026-07-30&end=2026-08-01"
    );
    expect(capturedHeaders.Authorization).toBe("Bearer tok");
    expect(capturedHeaders["User-Agent"]).toBe("beacon (+https://github.com/Defiabell/beacon)");
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual({ site: "defiabell", date: "2026-07-30", pageviews: 12, visitors: 8 });
  });

  it("throws with the status code on non-2xx", async () => {
    const bad: typeof fetch = async () => new Response("nope", { status: 500 });
    await expect(
      fetchSiteDaily("defiabell", "tok", "2026-07-30", "2026-08-01", bad)
    ).rejects.toThrow(/500/);
  });
});
