// Day-by-day series for the /trends page and GET /api/trends.
//
// Everything the collectors store is already one row per day; the overview
// only ever showed it summed into a 7- or 14-day figure. This reads the same
// tables as calendars instead: one slot per complete UTC day in the window,
// `null` where no row exists. A null is a day nobody recorded, and it is kept
// as null all the way to the page — the same rule src/metrics.ts states for
// the totals ("missing is not zero").
//
// Five D1 queries regardless of fleet size (see the fleet-wide readers in
// src/db.ts for why that matters).
import type { Env, SourceRun, RepoDaily } from "../types";
import { CONFIG, isZoneSite, siteFor, siteHosts } from "../config";
import { classifyDay } from "../impact/classify";
import { shiftDate } from "../impact/attribute";
import { getRepoDailyRange, getSiteDailyRange, getStarHistoryFrom, getWorkerDailyRange, listSourceRuns } from "../db";

export const TREND_WINDOWS = [7, 30, 90] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];
export const DEFAULT_TREND_WINDOW: TrendWindow = 30;

/** `?days=` -> a supported window; anything else falls back to the default. */
export function parseTrendWindow(raw: string | null): TrendWindow {
  const n = Number(raw);
  return (TREND_WINDOWS as readonly number[]).includes(n) ? (n as TrendWindow) : DEFAULT_TREND_WINDOW;
}

export type DaySeries = (number | null)[];

// A daily total with the same-length window before it, so a tile can say
// "up 12% on the previous 30 days". `previous` has the same number of slots as
// `values`; whether the comparison is trustworthy (both windows fully
// recorded) is decided where it is displayed, by windowDeltaPct.
export interface TrendMetric {
  values: DaySeries;
  previous: DaySeries;
}

export interface TrendGroup {
  key: string;
  label: string;
  /** Internal link for the entity, when it has a page of its own. */
  href?: string;
  values: DaySeries;
  total: number | null;
}

export interface TrendsData {
  days: TrendWindow;
  /** The window's complete UTC days, ascending; the last one is yesterday. */
  dates: string[];
  site: {
    pageviews: TrendMetric;
    visits: TrendMetric;
    /** Per hostname, busiest first. Hosts with no rows in the window are omitted. */
    bySite: (TrendGroup & { visits: DaySeries })[];
  };
  repo: {
    views: TrendMetric;
    uniques: DaySeries;
    /** Human-only (classifyDay) — the same reading the overview's "clones" uses. */
    clones: TrendMetric;
    machineClones: DaySeries;
    byRepo: TrendGroup[];
  };
  stars: {
    /** Fleet total per day; null on days no repo was snapshotted. */
    total: DaySeries;
    latest: number | null;
    /** Change across the window, null without a snapshot at both ends. */
    gained: number | null;
    byRepo: { project: string; values: DaySeries; latest: number | null; gained: number | null }[];
  };
  workers: {
    requests: TrendMetric;
    errors: DaySeries;
    byScript: TrendGroup[];
  };
  sources: SourceRun[];
}

/** The `days` complete UTC days before `today`, ascending. */
export function windowDates(today: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => shiftDate(today, i - days));
}

function sum(values: DaySeries): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

// Lays rows out on the calendar: for each date, the sum of `pick` over the
// rows that exist for it, or null when there are none. Summing only what
// exists is the honest total for a fleet whose members start being recorded
// on different days; a day with no rows at all stays a gap.
function onCalendar<T extends { date: string }>(rows: T[], dates: string[], pick: (row: T) => number): DaySeries {
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.date, (byDate.get(r.date) ?? 0) + pick(r));
  return dates.map(d => byDate.get(d) ?? null);
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function metric<T extends { date: string }>(rows: T[], dates: string[], prevDates: string[], pick: (row: T) => number): TrendMetric {
  return { values: onCalendar(rows, dates, pick), previous: onCalendar(rows, prevDates, pick) };
}

function byTotalDesc<T extends { total: number | null; label: string }>(a: T, b: T): number {
  return (b.total ?? -1) - (a.total ?? -1) || a.label.localeCompare(b.label);
}

function siteLabel(host: string): string {
  const cfg = siteFor(CONFIG.sites, host);
  // Same rule as the overview's site list: a zone-level entry names the zone,
  // so the host itself is the useful label there.
  return !cfg || isZoneSite(cfg) ? host : cfg.name;
}

// A star count is a state, so a repo with no snapshot on a given day still has
// stars that day: its last known count carries forward into the fleet total.
// The total is null only on days when no repo at all was snapshotted (the
// collector did not run), and before a repo's first snapshot it contributes
// nothing rather than a guessed zero.
function starTotals(byRepo: Map<string, { date: string; stars: number }[]>, dates: string[]): DaySeries {
  const snapshotDays = new Set<string>();
  for (const rows of byRepo.values()) for (const r of rows) snapshotDays.add(r.date);
  return dates.map(date => {
    if (!snapshotDays.has(date)) return null;
    let total = 0;
    for (const rows of byRepo.values()) {
      let last: number | null = null;
      for (const r of rows) {
        if (r.date > date) break;
        last = r.stars;
      }
      total += last ?? 0;
    }
    return total;
  });
}

function firstAndLast(values: DaySeries): { first: number | null; last: number | null } {
  const known = values.filter((v): v is number => v !== null);
  return { first: known[0] ?? null, last: known[known.length - 1] ?? null };
}

function gainedOver(values: DaySeries): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length >= 2 ? known[known.length - 1] - known[0] : null;
}

export async function buildTrends(env: Env, days: TrendWindow, today = new Date().toISOString().slice(0, 10)): Promise<TrendsData> {
  const db = env.DB;
  const dates = windowDates(today, days);
  const prevDates = windowDates(shiftDate(today, -days), days);
  const from = prevDates[0];

  const [siteRows, repoRows, starRows, workerRows, sources] = await Promise.all([
    getSiteDailyRange(db, from, today),
    getRepoDailyRange(db, from, today),
    // Stars only need the current window, plus a little before it so a repo
    // whose snapshot is missing on the window's first day still has a count
    // to carry into the fleet total.
    getStarHistoryFrom(db, shiftDate(dates[0], -14)),
    getWorkerDailyRange(db, from, today),
    listSourceRuns(db)
  ]);

  // ---- sites
  const inWindow = <T extends { date: string }>(rows: T[]) => rows.filter(r => r.date >= dates[0]);
  const knownHosts = new Set(CONFIG.sites.flatMap(siteHosts));
  const bySite = [...groupBy(inWindow(siteRows), r => r.site)]
    .map(([site, rows]) => {
      const values = onCalendar(rows, dates, r => r.pageviews);
      return { key: site, label: siteLabel(site), values, visits: onCalendar(rows, dates, r => r.visitors), total: sum(values) };
    })
    // A host that is neither configured nor carrying traffic is a stray row
    // (www redirecting to the apex, a typo'd subdomain) — not worth a chart.
    .filter(s => knownHosts.has(s.key) || (s.total ?? 0) > 0)
    .sort(byTotalDesc);

  // ---- repos
  const projectByRepo = new Map(CONFIG.projects.map(p => [p.repo, p.name]));
  const fleetRepoRows = repoRows.filter(r => projectByRepo.has(r.repo));
  const human = (r: RepoDaily) => classifyDay(r).humanClones;
  const byRepo: TrendGroup[] = CONFIG.projects
    .map(p => {
      const values = onCalendar(inWindow(fleetRepoRows).filter(r => r.repo === p.repo), dates, r => r.views);
      return { key: p.repo, label: p.name, href: `/p/${encodeURIComponent(p.name)}`, values, total: sum(values) };
    })
    .sort(byTotalDesc);

  // ---- stars
  const starsByRepo = groupBy(starRows.filter(r => projectByRepo.has(r.repo)), r => r.repo);
  const total = starTotals(starsByRepo, dates);
  const starsByProject = CONFIG.projects
    .map(p => {
      const rows = starsByRepo.get(p.repo) ?? [];
      const byDate = new Map(rows.map(r => [r.date, r.stars]));
      const values = dates.map(d => byDate.get(d) ?? null);
      return { project: p.name, values, latest: firstAndLast(values).last, gained: gainedOver(values) };
    })
    .sort((a, b) => (b.latest ?? -1) - (a.latest ?? -1) || a.project.localeCompare(b.project));

  // ---- workers
  const byScript: TrendGroup[] = [...groupBy(inWindow(workerRows), r => r.script)]
    .map(([script, rows]) => {
      const values = onCalendar(rows, dates, r => r.requests);
      return { key: script, label: script, values, total: sum(values) };
    })
    .sort(byTotalDesc);

  return {
    days,
    dates,
    site: {
      pageviews: metric(siteRows, dates, prevDates, r => r.pageviews),
      visits: metric(siteRows, dates, prevDates, r => r.visitors),
      bySite
    },
    repo: {
      views: metric(fleetRepoRows, dates, prevDates, r => r.views),
      uniques: onCalendar(fleetRepoRows, dates, r => r.uniqueViews),
      clones: metric(fleetRepoRows, dates, prevDates, human),
      machineClones: onCalendar(fleetRepoRows, dates, r => classifyDay(r).machineClones),
      byRepo
    },
    stars: { total, latest: firstAndLast(total).last, gained: gainedOver(total), byRepo: starsByProject },
    workers: {
      requests: metric(workerRows, dates, prevDates, r => r.requests),
      errors: onCalendar(workerRows, dates, r => r.errors),
      byScript
    },
    sources
  };
}
