import { describe, it, expect } from "vitest";
import { SURFACES, classifyReferrer } from "../src/surfaces";
import { buildSurfaceBreakdown } from "../src/api/public";
import type { PeakReferrer } from "../src/db";

const peak = (referrer: string, views: number, uniques: number, firstSeen = "2026-08-09", lastSeen = "2026-08-27"): PeakReferrer => ({
  referrer,
  views,
  uniques,
  firstSeen,
  lastSeen
});

describe("classifyReferrer", () => {
  it("recognises AI answer engines", () => {
    expect(classifyReferrer("chatgpt.com")).toBe("ai");
    expect(classifyReferrer("www.perplexity.ai")).toBe("ai");
    expect(classifyReferrer("gemini.google.com")).toBe("ai");
  });

  it("recognises search engines in GitHub's label form, not just as hostnames", () => {
    // Real referrer data contains the literal string "Google" — GitHub reports
    // search engines by display name. A hostname-only matcher silently drops
    // every search referral.
    expect(classifyReferrer("Google")).toBe("search");
    expect(classifyReferrer("google.com")).toBe("search");
  });

  it("does not mistake gemini.google.com for plain search", () => {
    // Both surfaces claim a google.com-ish host; the AI surface is listed first
    // and matches the more specific subdomain, which is what makes the ordering
    // load-bearing rather than incidental.
    expect(classifyReferrer("gemini.google.com")).toBe("ai");
    expect(classifyReferrer("google.com")).toBe("search");
  });

  it("treats every *.workers.dev page as our own site", () => {
    expect(classifyReferrer("beacon.defiabell.workers.dev")).toBe("own");
    expect(classifyReferrer("shotsync-demo.defiabell.workers.dev")).toBe("own");
  });

  it("returns null for hosts no surface claims", () => {
    // The resource-farm domains that appeared on shotsync. Bucketing them on a
    // guess is exactly what this null is protecting against.
    expect(classifyReferrer("seju.life")).toBeNull();
    expect(classifyReferrer("1fuli.one")).toBeNull();
  });

  it("matches subdomains but not lookalike suffixes", () => {
    expect(classifyReferrer("old.reddit.com")).toBe("community");
    expect(classifyReferrer("notreddit.com")).toBeNull();
  });
});

describe("buildSurfaceBreakdown", () => {
  it("emits every surface including the empty ones", () => {
    const out = buildSurfaceBreakdown(new Map([["shotsync", [peak("ruanyifeng.com", 506, 298)]]]));
    expect(out.surfaces).toHaveLength(SURFACES.length);
    // The whole reason this feature exists: "zero from AI answer engines" is a
    // finding, and filtering empty rows would delete it.
    const ai = out.surfaces.find(s => s.id === "ai");
    expect(ai).toBeDefined();
    expect(ai?.views).toBe(0);
  });

  it("sums across projects and records which hosts landed in each bucket", () => {
    const out = buildSurfaceBreakdown(
      new Map([
        ["shotsync", [peak("ruanyifeng.com", 506, 298), peak("v2ex.com", 30, 22)]],
        ["day-monitor", [peak("v2ex.com", 9, 9)]]
      ])
    );
    expect(out.surfaces.find(s => s.id === "curation")?.views).toBe(506);
    expect(out.surfaces.find(s => s.id === "community")?.views).toBe(39);
    expect(out.surfaces.find(s => s.id === "community")?.hosts).toEqual(["v2ex.com"]);
  });

  it("lists unclassified referrers by name instead of folding them into a total", () => {
    const out = buildSurfaceBreakdown(
      new Map([["shotsync", [peak("seju.life", 8, 7), peak("1fuli.one", 6, 4), peak("v2ex.com", 30, 22)]]])
    );
    expect(out.unclassified.map(u => u.referrer)).toEqual(["seju.life", "1fuli.one"]);
    // Descending by views, so the loudest unknown is the one you see first.
    expect(out.unclassified[0].views).toBe(8);
    // And it is never mixed into a classified bucket.
    const classifiedTotal = out.surfaces.reduce((n, s) => n + s.views, 0);
    expect(classifiedTotal).toBe(30);
  });

  it("reports the earliest snapshot as the observation floor", () => {
    const out = buildSurfaceBreakdown(
      new Map([
        ["a", [peak("v2ex.com", 1, 1, "2026-08-19")]],
        ["b", [peak("github.com", 1, 1, "2026-08-09")]]
      ])
    );
    // Everything above is bounded by when beacon started watching; GitHub does
    // not serve referrers older than a 14-day window.
    expect(out.since).toBe("2026-08-09");
  });

  it("has no observation floor when nothing has been captured", () => {
    expect(buildSurfaceBreakdown(new Map()).since).toBeNull();
  });
});
