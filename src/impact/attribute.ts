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

// Event time = COALESCE(published_at, created_at) for posts (design doc §2/§4);
// done_at for todos. Events are returned most-recent-first, matching /impact's
// "按时间倒序" listing.
export function buildEvents(posts: PostEventInput[], todos: TodoEventInput[]): ImpactEvent[] {
  const postEvents: ImpactEvent[] = posts.map(p => ({
    kind: "post",
    date: toCalendarDay(p.publishedAt ?? p.createdAt),
    project: p.project,
    title: p.title,
    platform: p.platform,
    url: p.url,
    postId: p.id
  }));
  const todoEvents: ImpactEvent[] = todos.map(t => ({
    kind: "todo",
    date: toCalendarDay(t.doneAt),
    project: t.project,
    title: t.title
  }));
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

export interface EventImpact {
  event: ImpactEvent;
  before: ImpactWindow;
  after: ImpactWindow;
  status: ImpactStatus;
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
