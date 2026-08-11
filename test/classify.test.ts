import { describe, it, expect } from "vitest";
import { classifyDay } from "../src/impact/classify";

// Rule under test (design doc §3, validated against production data): a day
// with zero unique visitors but nonzero clones can only be CI/bot activity —
// a human clone is preceded by at least one page view. classifyDay is a pure
// derived view over one repo_daily row; it must never mutate or drop data,
// only relabel it.
describe("classifyDay", () => {
  it("0 unique views + clones > 0 -> all clones counted as machine, zero human clones", () => {
    const result = classifyDay({ date: "2026-07-28", views: 0, uniqueViews: 0, clones: 38 });
    expect(result).toEqual({ date: "2026-07-28", humanViews: 0, humanClones: 0, machineClones: 38 });
  });

  it("some unique views + clones > 0 -> all clones counted as human, zero machine clones", () => {
    const result = classifyDay({ date: "2026-08-10", views: 26, uniqueViews: 12, clones: 3 });
    expect(result).toEqual({ date: "2026-08-10", humanViews: 26, humanClones: 3, machineClones: 0 });
  });

  it("zero views and zero clones -> everything zero, no crash", () => {
    const result = classifyDay({ date: "2026-08-05", views: 0, uniqueViews: 0, clones: 0 });
    expect(result).toEqual({ date: "2026-08-05", humanViews: 0, humanClones: 0, machineClones: 0 });
  });

  it("raw views pass through unchanged regardless of classification — only clones are split", () => {
    const machineDay = classifyDay({ date: "2026-07-28", views: 5, uniqueViews: 0, clones: 10 });
    // uniqueViews===0 still triggers the machine-day rule even if raw `views`
    // happens to be nonzero (a defensive case — GitHub's own numbers should
    // make this impossible, but the rule is defined on uniqueViews, not views).
    expect(machineDay.humanViews).toBe(5);
    expect(machineDay.machineClones).toBe(10);
  });

  it("never mutates the input row", () => {
    const row = { date: "2026-08-02", views: 4, uniqueViews: 3, clones: 1 };
    const frozen = Object.freeze({ ...row });
    expect(() => classifyDay(frozen)).not.toThrow();
    expect(frozen).toEqual(row);
  });
});
