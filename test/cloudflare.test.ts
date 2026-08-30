import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { normalizeWorkerRows, fetchWorkerDaily } from "../src/collect/cloudflare";
import { upsertWorkerDaily, getWorkerTotals } from "../src/db";

// Shaped exactly like a real response from the account (verified live against
// workersInvocationsAdaptive on 2026-08-30), so the mapping is pinned to the
// actual API rather than to a guess.
const REAL_SHAPE = {
  data: {
    viewer: {
      accounts: [
        {
          workersInvocationsAdaptive: [
            { sum: { requests: 7384, errors: 3, subrequests: 0 }, dimensions: { scriptName: "shotsync-demo", date: "2026-08-21" } },
            { sum: { requests: 57, errors: 0, subrequests: 0 }, dimensions: { scriptName: "tingfeng-comments", date: "2026-08-25" } }
          ]
        }
      ]
    }
  }
};

describe("normalizeWorkerRows", () => {
  it("maps the live response shape", () => {
    expect(normalizeWorkerRows(REAL_SHAPE)).toEqual([
      { script: "shotsync-demo", date: "2026-08-21", requests: 7384, errors: 3, subrequests: 0 },
      { script: "tingfeng-comments", date: "2026-08-25", requests: 57, errors: 0, subrequests: 0 }
    ]);
  });

  it("drops rows missing either primary-key dimension rather than inventing one", () => {
    const rows = normalizeWorkerRows({
      data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
        { sum: { requests: 5 }, dimensions: { date: "2026-08-21" } },            // no scriptName
        { sum: { requests: 5 }, dimensions: { scriptName: "beacon" } },          // no date
        { sum: { requests: 5 }, dimensions: { scriptName: "beacon", date: "2026-08-21" } }
      ] }] } }
    });
    expect(rows).toEqual([{ script: "beacon", date: "2026-08-21", requests: 5, errors: 0, subrequests: 0 }]);
  });

  it("defaults absent numeric fields to 0 instead of NaN", () => {
    const rows = normalizeWorkerRows({
      data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
        { sum: {}, dimensions: { scriptName: "beacon", date: "2026-08-21" } }
      ] }] } }
    });
    expect(rows[0]).toEqual({ script: "beacon", date: "2026-08-21", requests: 0, errors: 0, subrequests: 0 });
  });

  it("returns [] for every malformed envelope rather than throwing", () => {
    for (const bad of [null, undefined, 42, "nope", {}, { data: {} }, { data: { viewer: { accounts: [] } } }]) {
      expect(normalizeWorkerRows(bad)).toEqual([]);
    }
  });
});

describe("fetchWorkerDaily", () => {
  it("throws on a GraphQL errors array instead of reporting zero traffic", async () => {
    // The failure that actually happens: a token without analytics permission
    // returns HTTP 200 with an `errors` array. Treating that as "no rows" would
    // record a silent zero for every Worker.
    const stub: typeof fetch = async () =>
      Response.json({ errors: [{ message: "Authentication error" }], data: null });
    await expect(fetchWorkerDaily("acc", "tok", "2026-08-28", "2026-08-30", stub)).rejects.toThrow(/Authentication error/);
  });

  it("throws on a non-2xx response", async () => {
    const stub: typeof fetch = async () => new Response("nope", { status: 403 });
    await expect(fetchWorkerDaily("acc", "tok", "2026-08-28", "2026-08-30", stub)).rejects.toThrow(/403/);
  });

  it("sends the account tag and date range as GraphQL variables", async () => {
    let seen: any = null;
    const stub: typeof fetch = async (_u, init) => {
      seen = JSON.parse(String(init?.body));
      return Response.json(REAL_SHAPE);
    };
    const rows = await fetchWorkerDaily("acc-123", "tok", "2026-08-28", "2026-08-30", stub);
    expect(seen.variables).toEqual({ acc: "acc-123", start: "2026-08-28", end: "2026-08-30" });
    expect(rows).toHaveLength(2);
  });
});

describe("worker_daily storage", () => {
  it("upserts in place so a restated day corrects rather than duplicates", async () => {
    // Cloudflare revises recent days as data settles, which is why the
    // collector re-fetches a 3-day window every run.
    await upsertWorkerDaily(env.DB, [{ script: "w", date: "2026-08-29", requests: 100, errors: 1, subrequests: 0 }]);
    await upsertWorkerDaily(env.DB, [{ script: "w", date: "2026-08-29", requests: 140, errors: 2, subrequests: 0 }]);
    const row = await env.DB.prepare("select requests, errors from worker_daily where script='w' and date='2026-08-29'")
      .first<{ requests: number; errors: number }>();
    expect(row).toEqual({ requests: 140, errors: 2 });
  });

  it("totals a trailing window measured from the newest row, not from today", async () => {
    // Anchoring on today would collapse the window to nothing after a missed
    // collection run, silently reporting 0 traffic.
    await upsertWorkerDaily(env.DB, [
      { script: "busy", date: "2026-01-10", requests: 500, errors: 0, subrequests: 0 },
      { script: "busy", date: "2026-01-09", requests: 300, errors: 2, subrequests: 0 },
      { script: "busy", date: "2026-01-01", requests: 999, errors: 0, subrequests: 0 }, // outside a 7-day window
      { script: "quiet", date: "2026-01-10", requests: 4, errors: 0, subrequests: 0 }
    ]);
    const totals = await getWorkerTotals(env.DB, 7);
    const busy = totals.find(t => t.script === "busy")!;
    expect(busy.requests).toBe(800); // 500 + 300, the 2026-01-01 row excluded
    expect(busy.errors).toBe(2);
    // Busiest first, so the loudest script is the one you read.
    expect(totals[0].script).toBe("busy");
  });
});
