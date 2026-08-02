import { describe, it, expect } from "vitest";
import { CHANNELS, fitScore, suggestPairs } from "../src/channels";
import { CONFIG } from "../src/config";

describe("channels", () => {
  it("has at least 15 channels with tags", () => {
    expect(CHANNELS.length).toBeGreaterThanOrEqual(15);
    for (const c of CHANNELS) expect(c.tags.length).toBeGreaterThan(0);
  });
  it("fitScore counts tag intersection", () => {
    const p = { name: "x", repo: "o/x", tags: ["macos", "tool"] };
    const c = { id: "r-macapps", name: "r/macapps", url: "", lang: "en" as const, tags: ["macos"] };
    expect(fitScore(p, c)).toBe(1);
  });
  it("suggestPairs excludes covered channels and sorts by score desc", () => {
    const projects = [{ name: "day-monitor", repo: "Defiabell/day-monitor", tags: ["macos", "tool", "ai"] }];
    const covered = [{ project: "day-monitor", channelId: "v2ex", status: "posted" }];
    const s = suggestPairs(projects, covered);
    expect(s.find(x => x.channelId === "v2ex")).toBeUndefined();
    for (let i = 1; i < s.length; i++) expect(s[i - 1].score).toBeGreaterThanOrEqual(s[i].score);
    expect(s.every(x => x.score > 0)).toBe(true);
  });
  it("config projects reference valid repos", () => {
    for (const p of CONFIG.projects) expect(p.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });
});
