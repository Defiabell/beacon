// Attribution engine (design doc §4): builds ImpactEvent[] from posts/todos
// and computes each event's before/after 7-day windows. Pure functions only —
// no network, no DB. src/api/public.ts's buildImpact is the one place that
// reads real data and hands it to these.
import type { RepoDaily, Platform } from "../types";
import { classifyDay } from "./classify";

export type EventKind = "post" | "todo";

export interface ImpactEvent {
  kind: EventKind;
  date: string; // normalized "YYYY-MM-DD", a UTC calendar day
  project: string;
  title: string;
  platform?: Platform; // "post" events only
  url?: string; // "post" events only
  postId?: number; // "post" events only — links back to posts.id (src/api/public.ts's buildMatrix uses this to attach an effect chip to the specific channel cell a post was registered against)
}

export interface PostEventInput {
  id?: number;
  project: string;
  platform: Platform;
  title: string;
  url: string;
  publishedAt: string | null;
  createdAt: string;
}

export interface TodoEventInput {
  project: string;
  title: string;
  doneAt: string;
}

// SQLite datetime('now')/ISO timestamps and bare "YYYY-MM-DD" dates both
// start with the calendar day; slicing to 10 characters normalizes either
// shape to the same "YYYY-MM-DD" repo_daily.date / star_history.date use.
function toCalendarDay(s: string): string {
  return s.slice(0, 10);
}

// A "YYYY-MM-DD" string is only trustworthy once it round-trips through a
// real Date — the regex alone accepts syntactically well-formed nonsense
// (e.g. "2026-13-45"), and `new Date(...)` silently rolls a merely-out-of-
// range day into the next month (e.g. "2026-02-30" -> "2026-03-02") rather
// than producing an Invalid Date for it. Comparing the round-tripped ISO
// date back to the input catches both cases, plus anything that isn't even
// date-shaped (e.g. "08/09/2026", where `new Date(...)` is Invalid Date and
// `.getTime()` is NaN).
//
// Review item 3: a date failing this check must never reach shiftDate/
// computeImpact below — `new Date(badDate).toISOString()` there throws a
// RangeError on an Invalid Date, which 500s every route that reads events
// (/impact, /api/impact, /matrix, /p/:name) until someone edits the row by
// hand. src/api/admin.ts's createPost rejects the obviously-malformed shape
// at write time, but this is the second, unconditional line of defense: it
// also covers rows written before that guard existed, or edited directly.
function isValidCalendarDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

// Event time = COALESCE(published_at, created_at) for posts (design doc §2/§4);
// done_at for todos. Events are returned most-recent-first, matching /impact's
// "按时间倒序" listing. A row whose resulting day isn't a valid calendar date is
// dropped rather than turned into an event — see isValidCalendarDay above.
export function buildEvents(posts: PostEventInput[], todos: TodoEventInput[]): ImpactEvent[] {
  const postEvents: ImpactEvent[] = posts.flatMap((p): ImpactEvent[] => {
    const date = toCalendarDay(p.publishedAt ?? p.createdAt);
    if (!isValidCalendarDay(date)) return [];
    return [{ kind: "post", date, project: p.project, title: p.title, platform: p.platform, url: p.url, postId: p.id }];
  });
  const todoEvents: ImpactEvent[] = todos.flatMap((t): ImpactEvent[] => {
    const date = toCalendarDay(t.doneAt);
    if (!isValidCalendarDay(date)) return [];
    return [{ kind: "todo", date, project: t.project, title: t.title }];
  });
  return [...postEvents, ...todoEvents].sort((a, b) => b.date.localeCompare(a.date));
}

// Shifts a "YYYY-MM-DD" date string by `deltaDays` (may be negative) using
// UTC calendar arithmetic — avoids local-timezone drift shifting the date
// part. src/api/public.ts's computeStarsDelta imports this copy rather than
// each module keeping its own, and rather than public.ts exporting one for
// this module to import — public.ts already needs to import from this
// module (buildImpact calls buildEvents/computeImpacts), so the reverse
// import would form a cycle.
export function shiftDate(date: string, deltaDays: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

const WINDOW_DAYS = 7;

export interface ImpactWindow {
  days: number; // count of repo_daily rows actually present in this window's date range — NOT a fixed 7. A day GitHub hasn't reported yet (or that predates collection) is simply absent, not a fabricated 0.
  views: number;
  humanClones: number;
  starsDelta: number;
}

export type ImpactStatus = "complete" | "collecting" | "insufficient-history";

// Whether this event may be credited with the window numbers beside it at all.
//
// computeImpact answers "what did the repo do in the 7 days around this event".
// That is a coincidence question, not a causal one, and on a busy week it hands
// the same spike to everything inside it: yixi's 2026-09-05..09-07 window had a
// V2EX post, three curation self-submissions and one "set a social preview
// image" todo each reporting the same +38~47 stars / ~750 views. Only one of
// them caused it — 阮一峰周刊 published, and referrer data says so plainly
// (ruanyifeng.com, 369 views). The other two submissions were never picked up.
//
// src/api/public.ts's referredTrafficFor already draws exactly this distinction
// for the channel matrix; this carries the verdict onto the impact rows, which
// are the page that reads as a causal claim.
export type AttributionVerdict =
  // The channel's own publication host really did refer people. `views` is
  // what it referred — the number this event has a claim to.
  | "referred"
  // Observable channel, referred nobody. The window lift belongs to something
  // else, and must not be shown as this event's result.
  | "no-referral"
  // The channel declares no referrer host: it publishes off-web (GitHubDaily
  // goes out via 微博/公众号) or its host is too generic to attribute (an
  // awesome-list merge arrives as plain github.com). Unknowable, not zero.
  | "unobservable"
  // Published before beacon's first referrer snapshot for this repo. GitHub
  // only serves a 14-day referrer window, so this can never be recovered.
  | "predates-coverage"
  // A finished todo is a repo improvement, not a distribution act. It has no
  // channel and therefore no referrer signature to check it against.
  | "not-a-channel";

export interface EventAttribution {
  verdict: AttributionVerdict;
  channelId?: string;
  channelName?: string;
  views: number;
  uniques: number;
  // The matched host is claimed by more than one channel, so these numbers
  // describe the host rather than this channel alone.
  sharedHost: boolean;
}

// Structural mirror of src/api/public.ts's ReferredTraffic. Declared here
// rather than imported so this module stays free of the API layer (and of the
// import cycle that would create); ReferredTraffic satisfies it by shape.
export interface ReferralReading {
  views: number;
  uniques: number;
  sharedHost: boolean;
  predatesCoverage: boolean;
}

export function attributionFor(
  kind: EventKind,
  channel: { id: string; name: string } | undefined,
  reading: ReferralReading | undefined
): EventAttribution {
  const none = { views: 0, uniques: 0, sharedHost: false };
  if (kind === "todo") return { verdict: "not-a-channel", ...none };
  if (!channel) return { verdict: "unobservable", ...none };
  const named = { channelId: channel.id, channelName: channel.name };
  // undefined reading == the channel declares no referrer hosts at all, which
  // referredTrafficFor signals by returning undefined rather than zeroes.
  if (!reading) return { verdict: "unobservable", ...named, ...none };
  // Order matters: a non-zero reading is checked BEFORE predatesCoverage.
  // predatesCoverage exists to stop a *zero* being read as "referred nobody"
  // when the truth is "we were not watching yet" — it says nothing against
  // traffic we did observe. beacon only started snapshotting yixi's referrers
  // on 2026-09-11, six days after its 09-05 submissions, yet ruanyifeng.com
  // sits in that snapshot with 369 views: the channel demonstrably referred
  // people. Checking the flag first threw that evidence away and reported
  // "unknowable" for the one event on the page that was actually provable.
  // Late coverage can only make the number a floor, never make it false.
  if (reading.views > 0) {
    return {
      verdict: "referred",
      ...named,
      views: reading.views,
      uniques: reading.uniques,
      sharedHost: reading.sharedHost
    };
  }
  if (reading.predatesCoverage) {
    return { verdict: "predates-coverage", ...named, ...none, sharedHost: reading.sharedHost };
  }
  return { verdict: "no-referral", ...named, ...none, sharedHost: reading.sharedHost };
}

export interface EventImpact {
  event: ImpactEvent;
  before: ImpactWindow;
  after: ImpactWindow;
  status: ImpactStatus;
  // Attached by src/api/public.ts's buildImpact, which is the layer that can
  // reach the channel links and referrer snapshots. computeImpacts stays pure
  // and leaves this undefined.
  attribution?: EventAttribution;
}

function sumViews(rows: RepoDaily[]): number {
  return rows.reduce((sum, r) => sum + r.views, 0);
}

function sumHumanClones(rows: RepoDaily[]): number {
  return rows.reduce((sum, r) => sum + classifyDay(r).humanClones, 0);
}

// Latest known cumulative star count at or before `date`. `series` must be
// ascending by date (as returned by getStarSeries). Missing history is
// treated as 0 rather than unknown — the same convention src/api/public.ts's
// computeStarsDelta already uses for its own short-history fallback. This is
// also what gives "not yet reported" days honest behavior for free: asking
// for a date past the last recorded row simply returns the latest value
// that *is* recorded, rather than needing a special case.
function starsAsOf(series: { date: string; stars: number }[], date: string): number {
  let value = 0;
  for (const row of series) {
    if (row.date <= date) value = row.stars;
    else break;
  }
  return value;
}

function windowFor(
  repoDaily: RepoDaily[],
  starHistory: { date: string; stars: number }[],
  startDate: string,
  endDate: string,
  baselineDate: string
): ImpactWindow {
  const rows = repoDaily.filter(r => r.date >= startDate && r.date <= endDate);
  return {
    days: rows.length,
    views: sumViews(rows),
    humanClones: sumHumanClones(rows),
    starsDelta: starsAsOf(starHistory, endDate) - starsAsOf(starHistory, baselineDate)
  };
}

// Computes one event's before/after impact (design doc §4). `repoDaily` and
// `starHistory` should be the full history for the event's project — any
// date range/order is fine (windowFor filters to the exact window it needs).
//
// Honesty rule (design doc, the thing most likely to be got wrong): an
// event's `after` window covers [event day, event day + 6] inclusive; if
// fewer than 7 of those days have actually landed in repo_daily yet (GitHub's
// traffic API reports through "yesterday", and beacon's own cron lags a
// further day), status is "collecting" — the caller must never render that
// window's numbers as a final, complete zero. `before` covers the 7 days
// strictly before the event; if fewer than 7 of those are present, the event
// is too close to the start of collected history for a fair baseline —
// "insufficient-history". Status priority: an incomplete `after` window
// always wins (it's the case where showing "0" would actively mislead);
// `before` being short on its own never becomes "collecting" — the past
// doesn't get any more complete with time, so there's nothing to wait for.
export function computeImpact(event: ImpactEvent, repoDaily: RepoDaily[], starHistory: { date: string; stars: number }[]): EventImpact {
  const beforeStart = shiftDate(event.date, -WINDOW_DAYS);
  const beforeEnd = shiftDate(event.date, -1);
  const afterStart = event.date;
  const afterEnd = shiftDate(event.date, WINDOW_DAYS - 1);
  const beforeBaseline = shiftDate(event.date, -WINDOW_DAYS - 1);

  const before = windowFor(repoDaily, starHistory, beforeStart, beforeEnd, beforeBaseline);
  // after's baseline is beforeEnd — the day immediately preceding it — so the
  // two windows' star deltas chain continuously with no gap and no overlap.
  const after = windowFor(repoDaily, starHistory, afterStart, afterEnd, beforeEnd);

  const status: ImpactStatus = after.days < WINDOW_DAYS ? "collecting" : before.days < WINDOW_DAYS ? "insufficient-history" : "complete";

  return { event, before, after, status };
}

export function computeImpacts(
  events: ImpactEvent[],
  dataByProject: Map<string, { repoDaily: RepoDaily[]; starHistory: { date: string; stars: number }[] }>
): EventImpact[] {
  return events.map(event => {
    const data = dataByProject.get(event.project) ?? { repoDaily: [], starHistory: [] };
    return computeImpact(event, data.repoDaily, data.starHistory);
  });
}
