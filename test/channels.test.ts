import { describe, it, expect } from "vitest";
import { CHANNELS, fitScore, suggestPairs } from "../src/channels";
import type { ChannelKind } from "../src/channels";
import { CONFIG } from "../src/config";

const KINDS: ChannelKind[] = ["post", "list-pr", "pitch", "listing"];

describe("channels", () => {
  it("has at least 15 channels with tags", () => {
    expect(CHANNELS.length).toBeGreaterThanOrEqual(15);
    for (const c of CHANNELS) expect(c.tags.length).toBeGreaterThan(0);
  });

  // The matrix now renders `url`, `kind`, and `howTo` for every channel; a
  // channel added without them would render an empty link and an empty
  // instruction line — exactly the "a name you can't act on" problem this
  // metadata exists to fix, just silently instead of visibly.
  it("every channel carries a reachable url, a known kind, and a non-trivial howTo", () => {
    for (const c of CHANNELS) {
      expect(c.url, c.id).toMatch(/^https:\/\/\S+$/);
      expect(KINDS, c.id).toContain(c.kind);
      // Long enough to actually say what to do — a 3-character placeholder
      // would pass a bare truthiness check.
      expect(c.howTo.length, c.id).toBeGreaterThan(20);
    }
  });

  // Channel ids are interpolated into two places that must agree: an `href`
  // fragment (`/matrix#ch-<id>`, via encodeURIComponent) and the matching
  // element `id` attribute (via esc). Both are the identity function on a plain
  // slug, so restricting ids to slugs is what keeps the deep-link working —
  // hence asserted rather than assumed.
  it("channel ids are plain slugs, and unique", () => {
    for (const c of CHANNELS) expect(c.id).toMatch(/^[a-z0-9-]+$/);
    expect(new Set(CHANNELS.map(c => c.id)).size).toBe(CHANNELS.length);
  });

  it("fitScore counts tag intersection", () => {
    const p = { name: "x", repo: "o/x", tags: ["macos", "tool"] };
    const c = {
      id: "r-macapps",
      name: "r/macapps",
      url: "https://www.reddit.com/r/macapps/",
      lang: "en" as const,
      tags: ["macos"],
      kind: "post" as const,
      howTo: "带截图，并说明免费还是付费。"
    };
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
