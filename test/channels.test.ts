import { describe, it, expect } from "vitest";
import {
  CHANNELS,
  fitScore,
  suggestPairs,
  referrerMatchesChannel,
  channelHasSharedReferrerHost,
  channelForPostUrl
} from "../src/channels";
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

describe("referrer hosts", () => {
  const byId = (id: string) => {
    const c = CHANNELS.find(x => x.id === id);
    if (!c) throw new Error(`no channel ${id}`);
    return c;
  };

  it("every channel declares referrerHosts (possibly empty, never missing)", () => {
    for (const c of CHANNELS) expect(Array.isArray(c.referrerHosts)).toBe(true);
  });

  it("matches the publication host, which is not the submission host", () => {
    const weekly = byId("ruanyf-weekly");
    // Submitted at github.com, published at ruanyifeng.com. Keying off the
    // channel's own `url` host would have credited every GitHub referral to it.
    expect(weekly.url).toContain("github.com");
    expect(referrerMatchesChannel("ruanyifeng.com", weekly)).toBe(true);
    expect(referrerMatchesChannel("github.com", weekly)).toBe(false);
  });

  it("matches subdomains but not lookalike suffixes", () => {
    const v2ex = byId("v2ex");
    expect(referrerMatchesChannel("www.v2ex.com", v2ex)).toBe(true);
    expect(referrerMatchesChannel("v2ex.com", v2ex)).toBe(true);
    expect(referrerMatchesChannel("notv2ex.com", v2ex)).toBe(false);
    expect(referrerMatchesChannel("v2ex.com.evil.net", v2ex)).toBe(false);
  });

  it("appinn claims both its forum and its article site", () => {
    const appinn = byId("appinn");
    // meta.appinn.net is not a subdomain of appinn.com, so suffix matching
    // alone would miss the forum — the real submission surface, and where
    // shotsync's 15 referred views actually came from.
    expect(referrerMatchesChannel("meta.appinn.net", appinn)).toBe(true);
    expect(referrerMatchesChannel("appinn.com", appinn)).toBe(true);
  });

  it("ignores GitHub's non-hostname referrer labels", () => {
    // Real referrer data contains entries like "Google" that are not hosts.
    for (const c of CHANNELS) expect(referrerMatchesChannel("Google", c)).toBe(false);
  });

  it("flags channels that share a publication host", () => {
    // All four subreddits publish under reddit.com, so a reddit.com referral
    // cannot be pinned to one of them.
    expect(channelHasSharedReferrerHost(byId("r-macapps"))).toBe(true);
    expect(channelHasSharedReferrerHost(byId("r-selfhosted"))).toBe(true);
    expect(channelHasSharedReferrerHost(byId("ruanyf-weekly"))).toBe(false);
  });

  it("declares off-web and un-attributable channels as unobservable", () => {
    // GitHubDaily publishes via 微博/公众号 (no referrer); an awesome-list merge
    // arrives as bare github.com, which is indistinguishable from GitHub's own
    // trending and search surfaces.
    expect(byId("githubdaily").referrerHosts).toEqual([]);
    expect(byId("awesome-mac").referrerHosts).toEqual([]);
  });
});

describe("channelForPostUrl", () => {
  it("resolves a post on a host only one channel uses", () => {
    expect(channelForPostUrl("https://www.v2ex.com/t/1239805")?.id).toBe("v2ex");
  });

  // The case that made this function necessary: five channels publish under
  // github.com, so matching on host alone credited whichever one CHANNELS
  // happened to list first. yixi's three 自荐 issue all live there.
  it("disambiguates channels that share github.com by owner/repo", () => {
    expect(channelForPostUrl("https://github.com/ruanyf/weekly/issues/11508")?.id).toBe("ruanyf-weekly");
    expect(channelForPostUrl("https://github.com/521xueweihan/HelloGitHub/issues/3642")?.id).toBe("hellogithub");
    expect(channelForPostUrl("https://github.com/GitHubDaily/GitHubDaily/issues/1067")?.id).toBe("githubdaily");
    expect(channelForPostUrl("https://github.com/tw93/weekly/discussions/22")?.id).toBe("tw93-weekly");
  });

  it("returns undefined for a github.com URL no channel claims", () => {
    expect(channelForPostUrl("https://github.com/Defiabell/beacon/issues/1")).toBeUndefined();
  });

  it("returns undefined for an unknown host and for a malformed URL", () => {
    expect(channelForPostUrl("https://example.com/post/1")).toBeUndefined();
    expect(channelForPostUrl("not a url")).toBeUndefined();
  });
});

describe("suggestPairs ranking", () => {
  const projects = [{ name: "p", repo: "o/p", tags: ["tool", "web", "zh", "en", "macos", "selfhosted", "ai", "game"] }];

  it("ranks a proven channel above a better-fitting unproven one", () => {
    // Give the proof to whichever channel scores worst, so fit alone would put
    // it last and only the proof term can lift it.
    const scored = CHANNELS.map(c => ({ c, score: fitScore(projects[0], c) })).filter(x => x.score > 0);
    const worst = scored.reduce((a, b) => (a.score <= b.score ? a : b)).c;
    const best = scored.reduce((a, b) => (a.score >= b.score ? a : b)).c;
    expect(fitScore(projects[0], worst)).toBeLessThan(fitScore(projects[0], best));

    const ranked = suggestPairs(projects, [], new Map([[worst.id, 500]]));
    expect(ranked[0].channelId).toBe(worst.id);
    expect(ranked[0].provenViews).toBe(500);
  });

  it("leaves unproven channels ordered by fit, and defaults provenViews to 0", () => {
    const ranked = suggestPairs(projects, []);
    expect(ranked.every(s => s.provenViews === 0)).toBe(true);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
  });
});
