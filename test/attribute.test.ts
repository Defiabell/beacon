import { describe, it, expect } from "vitest";
import {
  shiftDate,
  buildEvents,
  computeImpact,
  computeImpacts,
  type ImpactEvent
} from "../src/impact/attribute";
import type { RepoDaily } from "../src/types";

function repoRow(repo: string, date: string, views: number, uniqueViews: number, clones: number): RepoDaily {
  return { repo, date, views, uniqueViews, clones, uniqueClones: clones, stars: 0, forks: 0 };
}

describe("shiftDate", () => {
  it("shifts forward and backward using UTC calendar arithmetic", () => {
    expect(shiftDate("2026-08-09", 1)).toBe("2026-08-10");
    expect(shiftDate("2026-08-09", -1)).toBe("2026-08-08");
    expect(shiftDate("2026-08-09", 0)).toBe("2026-08-09");
  });

  it("crosses a month/year boundary correctly", () => {
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDate("2026-07-28", 7)).toBe("2026-08-04");
  });
});

describe("buildEvents", () => {
  it("post events use published_at when present, normalized to a bare YYYY-MM-DD day", () => {
    const events = buildEvents(
      [
        {
          id: 1,
          project: "shotsync",
          platform: "v2ex",
          title: "shotsync 发布",
          url: "https://www.v2ex.com/t/1",
          publishedAt: "2026-08-09",
          createdAt: "2026-08-01T00:00:00.000Z"
        }
      ],
      []
    );
    expect(events).toEqual([
      { kind: "post", date: "2026-08-09", project: "shotsync", title: "shotsync 发布", platform: "v2ex", url: "https://www.v2ex.com/t/1", postId: 1 }
    ]);
  });

  it("post events fall back to created_at (normalized to a day) when published_at is NULL", () => {
    const events = buildEvents(
      [
        {
          id: 2,
          project: "shotsync",
          platform: "v2ex",
          title: "no publish date",
          url: "https://www.v2ex.com/t/2",
          publishedAt: null,
          createdAt: "2026-08-09T12:25:06.976Z"
        }
      ],
      []
    );
    expect(events[0].date).toBe("2026-08-09");
  });

  it("todo events use done_at, normalized to a bare day", () => {
    const events = buildEvents([], [{ project: "nightide", title: "补 topics", doneAt: "2026-08-01T09:15:00.000Z" }]);
    expect(events).toEqual([{ kind: "todo", date: "2026-08-01", project: "nightide", title: "补 topics" }]);
  });

  it("sorts every event most-recent-first regardless of kind or input order", () => {
    const events = buildEvents(
      [{ id: 1, project: "a", platform: "hn", title: "old post", url: "u1", publishedAt: "2026-07-01", createdAt: "2026-07-01T00:00:00Z" }],
      [{ project: "a", title: "new todo", doneAt: "2026-08-05T00:00:00Z" }]
    );
    expect(events.map(e => e.date)).toEqual(["2026-08-05", "2026-07-01"]);
  });
});

describe("computeImpact — status branches", () => {
  const EVENT: ImpactEvent = { kind: "post", date: "2026-08-09", project: "x", title: "t", platform: "v2ex", url: "u" };

  it("complete: both before (7d) and after (7d) windows fully present", () => {
    const rows: RepoDaily[] = [];
    for (let d = 2; d <= 15; d++) rows.push(repoRow("x", `2026-08-${String(d).padStart(2, "0")}`, 5, 5, 0));
    const impact = computeImpact(EVENT, rows, []);
    expect(impact.status).toBe("complete");
    expect(impact.before.days).toBe(7);
    expect(impact.after.days).toBe(7);
  });

  it("collecting: after-window has fewer than 7 recorded days — and the numbers reflect only what's actually recorded, never a fabricated 0 for an unreported day", () => {
    const rows: RepoDaily[] = [];
    for (let d = 2; d <= 8; d++) rows.push(repoRow("x", `2026-08-${String(d).padStart(2, "0")}`, 3, 3, 0)); // full before window
    rows.push(repoRow("x", "2026-08-09", 3, 3, 0));
    rows.push(repoRow("x", "2026-08-10", 26, 20, 0)); // only 2 of the 7 after-days reported so far
    const impact = computeImpact(EVENT, rows, []);
    expect(impact.status).toBe("collecting");
    expect(impact.after.days).toBe(2);
    // The real recorded total (29), not a diluted "0 for the other 5 days" average.
    expect(impact.after.views).toBe(29);
    expect(impact.before.days).toBe(7);
  });

  it("insufficient-history: before-window predates the start of collected data, after-window is complete", () => {
    const rows: RepoDaily[] = [];
    // Only 3 days of history exist before the event (data collection started late).
    rows.push(repoRow("x", "2026-08-06", 1, 1, 0));
    rows.push(repoRow("x", "2026-08-07", 1, 1, 0));
    rows.push(repoRow("x", "2026-08-08", 1, 1, 0));
    for (let d = 9; d <= 15; d++) rows.push(repoRow("x", `2026-08-${String(d).padStart(2, "0")}`, 4, 4, 0));
    const impact = computeImpact(EVENT, rows, []);
    expect(impact.status).toBe("insufficient-history");
    expect(impact.before.days).toBe(3);
    expect(impact.after.days).toBe(7);
  });

  it("a project with zero repo_daily/star_history rows at all produces empty windows, not a crash", () => {
    const impact = computeImpact(EVENT, [], []);
    expect(impact.before).toEqual({ days: 0, views: 0, humanClones: 0, starsDelta: 0 });
    expect(impact.after).toEqual({ days: 0, views: 0, humanClones: 0, starsDelta: 0 });
    expect(impact.status).toBe("collecting");
  });

  it("sums humanClones via classifyDay — a zero-unique-view day's clones are excluded as machine traffic", () => {
    const rows: RepoDaily[] = [];
    for (let d = 2; d <= 8; d++) rows.push(repoRow("x", `2026-08-${String(d).padStart(2, "0")}`, 0, 0, 0));
    for (let d = 9; d <= 15; d++) {
      const date = `2026-08-${String(d).padStart(2, "0")}`;
      // one legit human clone day + one machine (0 unique views, 38 clones) day
      if (d === 9) rows.push(repoRow("x", date, 10, 8, 2));
      else if (d === 10) rows.push(repoRow("x", date, 0, 0, 38));
      else rows.push(repoRow("x", date, 1, 1, 0));
    }
    const impact = computeImpact(EVENT, rows, []);
    expect(impact.after.humanClones).toBe(2); // the 38 machine clones on 08-10 are excluded
  });

  it("star window delta uses the day immediately before each window as its baseline, and 'as of' semantics for a not-yet-reported end date", () => {
    const stars = [
      { date: "2026-08-01", stars: 0 },
      { date: "2026-08-08", stars: 0 },
      { date: "2026-08-10", stars: 2 } // last known value; 08-11..08-15 unreported
    ];
    const rows: RepoDaily[] = [];
    for (let d = 2; d <= 10; d++) rows.push(repoRow("x", `2026-08-${String(d).padStart(2, "0")}`, 1, 1, 0));
    const impact = computeImpact(EVENT, rows, stars);
    expect(impact.before.starsDelta).toBe(0); // 0 (at 08-08) - 0 (at 08-01)
    expect(impact.after.starsDelta).toBe(2); // 2 (latest known, 08-10) - 0 (at 08-08)
  });
});

describe("computeImpacts (batch)", () => {
  it("looks up each event's project in the provided map, defaulting to empty data for an unknown project", () => {
    const events: ImpactEvent[] = [
      { kind: "post", date: "2026-08-09", project: "known", title: "t", platform: "v2ex", url: "u" },
      { kind: "todo", date: "2026-08-01", project: "unknown-project", title: "t2" }
    ];
    const rows: RepoDaily[] = [repoRow("known", "2026-08-09", 5, 5, 0)];
    const impacts = computeImpacts(events, new Map([["known", { repoDaily: rows, starHistory: [] }]]));
    expect(impacts).toHaveLength(2);
    expect(impacts[0].after.views).toBe(5);
    expect(impacts[1].before).toEqual({ days: 0, views: 0, humanClones: 0, starsDelta: 0 });
  });
});

// ---- Acceptance criterion (design doc §1 / task spec) -----------------------
// Production-shaped fixture: shotsync's V2EX post (2026-08-09) produced 26
// views the next day against a 0–6/day baseline, and took stars 0 -> 2. The
// engine must surface that as a clear positive signal — even while `after` is
// still "collecting" (only 2 of 7 days reported so far, matching beacon's
// real 1–2 day GitHub-traffic lag). nightide's 2026-07-27 post, by contrast,
// produced no meaningful change and must come out near zero.
describe("acceptance: shotsync 08-09 positive impact vs nightide 07-27 near-zero", () => {
  const shotsyncEvent: ImpactEvent = {
    kind: "post",
    date: "2026-08-09",
    project: "shotsync",
    title: "shotsync 分享创造",
    platform: "v2ex",
    url: "https://www.v2ex.com/t/1229945"
  };
  const shotsyncRepo = "Defiabell/shotsync";
  const shotsyncRows: RepoDaily[] = [
    repoRow(shotsyncRepo, "2026-08-02", 2, 2, 0),
    repoRow(shotsyncRepo, "2026-08-03", 4, 4, 0),
    repoRow(shotsyncRepo, "2026-08-04", 1, 1, 0),
    repoRow(shotsyncRepo, "2026-08-05", 6, 5, 0),
    repoRow(shotsyncRepo, "2026-08-06", 0, 0, 0),
    repoRow(shotsyncRepo, "2026-08-07", 3, 3, 0),
    repoRow(shotsyncRepo, "2026-08-08", 5, 4, 0),
    repoRow(shotsyncRepo, "2026-08-09", 3, 3, 0), // publish day itself
    repoRow(shotsyncRepo, "2026-08-10", 26, 20, 0) // the next day — only day reported so far after publish day
  ];
  const shotsyncStars = [
    { date: "2026-08-01", stars: 0 },
    { date: "2026-08-08", stars: 0 },
    { date: "2026-08-10", stars: 2 }
  ];

  it("shotsync: after-window (collecting, 2/7 days) already shows a clear positive signal", () => {
    const impact = computeImpact(shotsyncEvent, shotsyncRows, shotsyncStars);
    expect(impact.status).toBe("collecting");
    expect(impact.after.days).toBe(2);
    expect(impact.before.days).toBe(7);
    expect(impact.before.views).toBe(21); // 2+4+1+6+0+3+5
    expect(impact.after.views).toBe(29); // 3+26
    expect(impact.after.starsDelta).toBe(2); // 0 -> 2
    // The acceptance bar: per-day rate after clearly exceeds the baseline
    // per-day rate, even though the window isn't fully reported yet.
    expect(impact.after.views / impact.after.days).toBeGreaterThan(impact.before.views / impact.before.days);
  });

  const nightideEvent: ImpactEvent = { kind: "post", date: "2026-07-27", project: "nightide", title: "夜潮上线", platform: "v2ex", url: "https://www.v2ex.com/t/999" };
  const nightideRepo = "Defiabell/nightide";
  const nightideRows: RepoDaily[] = [
    repoRow(nightideRepo, "2026-07-20", 5, 5, 0),
    repoRow(nightideRepo, "2026-07-21", 6, 6, 0),
    repoRow(nightideRepo, "2026-07-22", 4, 4, 0),
    repoRow(nightideRepo, "2026-07-23", 5, 5, 0),
    repoRow(nightideRepo, "2026-07-24", 7, 6, 0),
    repoRow(nightideRepo, "2026-07-25", 5, 5, 0),
    repoRow(nightideRepo, "2026-07-26", 6, 6, 0),
    repoRow(nightideRepo, "2026-07-27", 6, 6, 0),
    repoRow(nightideRepo, "2026-07-28", 5, 5, 0),
    repoRow(nightideRepo, "2026-07-29", 5, 5, 0),
    repoRow(nightideRepo, "2026-07-30", 6, 6, 0),
    repoRow(nightideRepo, "2026-07-31", 4, 4, 0),
    repoRow(nightideRepo, "2026-08-01", 6, 6, 0),
    repoRow(nightideRepo, "2026-08-02", 5, 5, 0)
  ];
  const nightideStars = [{ date: "2026-07-01", stars: 100 }];

  it("nightide: a fully-reported before/after pair comes out near zero — no spike to report", () => {
    const impact = computeImpact(nightideEvent, nightideRows, nightideStars);
    expect(impact.status).toBe("complete");
    expect(impact.before.views).toBe(38); // 5+6+4+5+7+5+6
    expect(impact.after.views).toBe(37); // 6+5+5+6+4+6+5
    expect(Math.abs(impact.after.views - impact.before.views)).toBeLessThanOrEqual(2);
    expect(impact.after.starsDelta).toBe(0);
  });
});
