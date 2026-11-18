// Chart primitives for the SSR dashboard. Everything here returns an HTML
// string and needs no JavaScript in the browser: bars are flex children with a
// percentage height, the hover readout is a CSS `:hover` rule on each day's
// column, and the only SVG is the polyline of a line chart (stretched with
// preserveAspectRatio="none" so axis text stays HTML and never scales with the
// card). The styles live in src/ui/layout.ts next to the rest of the CSS.
//
// One rule runs through every function: a day with no recorded row is `null`,
// and null is drawn as a gap ("无记录"), never as a zero-height bar. That is the
// same "missing is not zero" contract src/metrics.ts states for the totals.
import { esc } from "./layout";

// ---- numbers & dates ------------------------------------------------------

/** 1284 -> "1,284". Plain regex rather than toLocaleString: no locale data needed. */
export function fmtInt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Stat-tile figure: in full under 10,000, compact above (12.9K / 4.2M). */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 10000) return fmtInt(n);
  const [div, unit] = abs < 1e6 ? [1e3, "K"] : [1e6, "M"];
  const v = n / div;
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`;
}

/** One style per axis: full figures until the axis itself reaches 10,000. */
function fmtTick(n: number, axisMax: number): string {
  return axisMax >= 10000 ? fmtCompact(n) : fmtInt(n);
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** "2026-11-12" -> "11-12 周四". Dates are UTC days, same clock as the collectors. */
export function fmtDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const wd = Number.isNaN(d.getTime()) ? "" : ` ${WEEKDAYS[d.getUTCDay()]}`;
  return `${date.slice(5)}${wd}`;
}

/** Sum of the recorded days; null when nothing was recorded at all. */
export function sumOrNull(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

/**
 * Axis ticks from 0 (or from a floor, for a cumulative line) in a 1/2/5 step,
 * never fractional: everything charted here is a count.
 */
export function niceTicks(min: number, max: number, target = 4): number[] {
  const span = Math.max(max - min, 1);
  const raw = span / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(1, [1, 2, 5, 10].map(m => m * pow).find(s => s >= raw) ?? 10 * pow);
  const lo = Math.floor(min / step) * step;
  let hi = Math.ceil(max / step) * step;
  if (hi === lo) hi = lo + step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(t);
  return ticks;
}

// ---- icons ----------------------------------------------------------------

// Stroke icons on a 24 grid, drawn here rather than loaded (no external
// resources). `currentColor` so an icon takes the ink of the text beside it.
const ICON_PATHS: Record<string, string> = {
  beacon: '<circle cx="12" cy="12" r="2.2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>',
  overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  trends: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  matrix: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 4.5v15M15 4.5v15"/>',
  todos: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8 12.2l2.8 2.8L16 9.5"/>',
  posts: '<path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z"/>',
  impact: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.8"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5S9.4 5.9 12 3.5z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c.6-3.2 2.9-5 6-5s5.4 1.8 6 5M16 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.8c1.9.6 3.1 2.2 3.5 4.7"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.8L12 16.8l-5.3 2.8 1.1-5.8-4.3-4.1 5.9-.8z"/>',
  clone: '<path d="M12 4v10.5M7.5 10.5L12 15l4.5-4.5M4.5 19.5h15"/>',
  server: '<rect x="3.5" y="4" width="17" height="6.5" rx="1.8"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.8"/><path d="M7 7.25h.01M7 16.75h.01"/>',
  repo: '<path d="M5 4.5h12.5a1.5 1.5 0 0 1 1.5 1.5v13.5H6.5A1.5 1.5 0 0 1 5 18z"/><path d="M5 16.5h14M9 8.5h6"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  bolt: '<path d="M13 3.5L5.5 13.5H11l-1 7 7.5-10H12z"/>',
  table: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>'
};

export type IconName = keyof typeof ICON_PATHS;

export function icon(name: string, size = 16): string {
  const paths = ICON_PATHS[name];
  if (!paths) return "";
  return (
    `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  );
}

// ---- day chart ------------------------------------------------------------

export interface ChartMarker {
  date: string;
  label: string;
}

export interface DayChartOptions {
  /** One column per entry, ascending. */
  dates: string[];
  /** The plotted series. `null` = no record for that day. */
  values: (number | null)[];
  /** What the plotted number is, e.g. "浏览". Shown in the hover readout. */
  label: string;
  /** Same-unit companions listed in the hover readout only (never a second axis). */
  extra?: { label: string; values: (number | null)[] }[];
  kind?: "bar" | "line";
  /** Plot height in px. */
  height?: number;
  /** Small-multiple form: no y-axis labels, first/last date only. */
  mini?: boolean;
  /** Dated annotations (a post, a finished todo) drawn as a vertical rule. */
  markers?: ChartMarker[];
  /** Extra readout lines for a day (e.g. that day's top referrers), keyed by date; one line each. No mark is drawn. */
  notes?: Record<string, string[]>;
  ariaLabel?: string;
}

function pct(n: number): string {
  return `${Math.round(n * 100) / 100}%`;
}

// Which columns get a date label under the axis: counted back from the last
// day so the most recent column is always labelled. Whole weeks apart, and few
// enough (five on the 90-day chart) that they still clear each other at phone
// width, where a 14-day step put two labels on top of one another.
function labelledIndexes(n: number): Set<number> {
  const step = n <= 10 ? 1 : n <= 16 ? 2 : n <= 45 ? 7 : 21;
  const out = new Set<number>();
  for (let i = n - 1; i >= 0; i -= step) out.add(i);
  return out;
}

function readoutRow(label: string, value: number | null): string {
  return `<span class="tip-row"><b>${value === null ? "无记录" : fmtInt(value)}</b>${esc(label)}</span>`;
}

/**
 * A per-day chart: columns (default) for daily counts, a line for a running
 * total such as stars. Returns "" when there is nothing to plot at all, so the
 * caller can print its own empty state.
 */
export function dayChart(o: DayChartOptions): string {
  const n = o.dates.length;
  const known = o.values.filter((v): v is number => v !== null);
  if (n === 0 || known.length === 0) return "";

  const kind = o.kind ?? "bar";
  const height = o.height ?? (o.mini ? 64 : 180);
  const max = Math.max(...known);
  // A line (running total) may start above zero; bars always grow from zero.
  const ticks = kind === "line" ? niceTicks(Math.min(...known), max, o.mini ? 2 : 4) : niceTicks(0, max, o.mini ? 2 : 4);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const yOf = (v: number) => ((v - lo) / (hi - lo)) * 100;

  const markersByDate = new Map<string, string[]>();
  for (const m of o.markers ?? []) markersByDate.set(m.date, [...(markersByDate.get(m.date) ?? []), m.label]);

  const lastKnown = o.values.reduce<number>((last, v, i) => (v !== null ? i : last), -1);

  const cols = o.dates
    .map((date, i) => {
      const v = o.values[i];
      const events = markersByDate.get(date) ?? [];
      // Keep the readout inside the card at either end of the plot.
      const side = i < n * 0.25 ? " tl" : i >= n * 0.75 ? " tr" : "";
      const cls = `col${v === null ? " miss" : ""}${side}`;
      let mark = "";
      if (v !== null && kind === "bar") {
        // A non-zero day always shows at least a sliver; a zero day draws nothing.
        mark = v > 0 ? `<i class="bar" style="height:max(2px,${pct(yOf(v))})"></i>` : "";
      } else if (v !== null) {
        mark = `<i class="pt${i === lastKnown ? " end" : ""}" style="bottom:${pct(yOf(v))}"></i>`;
      }
      const marker = events.length ? `<i class="marker" title="${esc(events.map(e => `${date} ${e}`).join("；"))}"></i>` : "";
      const tip =
        `<span class="tip"><span class="tip-date">${esc(fmtDay(date))}</span>` +
        readoutRow(o.label, v) +
        (o.extra ?? []).map(x => readoutRow(x.label, x.values[i] ?? null)).join("") +
        events.map(e => `<span class="tip-ev">${esc(e)}</span>`).join("") +
        (o.notes?.[date] ?? []).map((line, k) => `<span class="tip-note${k === 0 ? " first" : ""}">${esc(line)}</span>`).join("") +
        `</span>`;
      return `<span class="${cls}">${marker}${mark}${tip}</span>`;
    })
    .join("");

  // The line itself: one polyline per unbroken run, so a missing day breaks
  // the line instead of being bridged by a straight segment that asserts data.
  let line = "";
  if (kind === "line") {
    const runs: string[][] = [];
    let run: string[] = [];
    o.values.forEach((v, i) => {
      if (v === null) {
        if (run.length) runs.push(run);
        run = [];
        return;
      }
      run.push(`${i + 0.5},${Math.round((100 - yOf(v)) * 100) / 100}`);
    });
    if (run.length) runs.push(run);
    line =
      `<svg class="ln" viewBox="0 0 ${n} 100" preserveAspectRatio="none" aria-hidden="true">` +
      runs.map(r => `<polyline points="${r.join(" ")}" vector-effect="non-scaling-stroke"/>`).join("") +
      `</svg>`;
  }

  const grid = ticks
    .slice(1)
    .map(t => `<i class="gl" style="bottom:${pct(yOf(t))}"></i>`)
    .join("");
  // The labels are absolutely positioned on their gridlines, so the axis
  // column has no intrinsic width; size it to the widest label.
  const tickText = ticks.map(t => fmtTick(t, hi));
  const yWidth = Math.max(...tickText.map(t => t.length)) + 0.5;
  const yAxis = o.mini
    ? ""
    : `<div class="yax" style="width:${yWidth}ch">${ticks.map((t, i) => `<span style="bottom:${pct(yOf(t))}">${tickText[i]}</span>`).join("")}</div>`;

  const labelled = labelledIndexes(n);
  const xAxis = o.mini
    ? `<div class="xax ends"><span>${esc(o.dates[0].slice(5))}</span><span>${esc(o.dates[n - 1].slice(5))}</span></div>`
    : `<div class="xax">${o.dates.map((d, i) => `<span${i === n - 1 ? ' class="r"' : ""}>${labelled.has(i) ? esc(d.slice(5)) : ""}</span>`).join("")}</div>`;

  const aria = o.ariaLabel ?? `${o.label}，按天，${o.dates[0]} 至 ${o.dates[n - 1]}`;
  return (
    `<div class="chart k-${kind}${o.mini ? " mini" : ""}" style="--h:${height}px" role="img" aria-label="${esc(aria)}">` +
    `${yAxis}<div class="plot">${grid}${line}<div class="days">${cols}</div></div>${xAxis}</div>`
  );
}

/** Whether any day in the window has no record — drives the "灰底 = 无记录" note. */
export function hasGaps(values: (number | null)[]): boolean {
  return values.some(v => v === null) && values.some(v => v !== null);
}

// ---- sparkline bars -------------------------------------------------------

/**
 * A word-sized column strip for a stat tile or a table row. No axis and no
 * hover: the figure beside it is the value, this only shows the shape.
 */
export function sparkBars(values: (number | null)[], opts: { title?: string; accentFrom?: number } = {}): string {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return "";
  const max = Math.max(...known, 1);
  // Bars before `accentFrom` are the comparison period and recede to gray, so
  // the current period reads as the subject.
  const accentFrom = opts.accentFrom ?? 0;
  const bars = values
    .map((v, i) => {
      if (v === null) return `<i class="miss"></i>`;
      const cls = i < accentFrom ? ' class="prev"' : "";
      return `<i${cls} style="height:${v > 0 ? `max(2px,${pct((v / max) * 100)})` : "1px"}"></i>`;
    })
    .join("");
  return `<span class="spark"${opts.title ? ` title="${esc(opts.title)}"` : ""} aria-hidden="true">${bars}</span>`;
}

// ---- ranked bars ----------------------------------------------------------

export interface RankRow {
  /** Pre-built, already-escaped HTML for the name cell. */
  nameHtml: string;
  value: number | null;
  /** Pre-built short chips shown beside the name. */
  tagsHtml?: string;
  /** Pre-built HTML for a note on its own line under the row. */
  extraHtml?: string;
  /** Text for the figure when it isn't just the number (e.g. "484 / 462"). */
  valueText?: string;
  dim?: boolean;
  spark?: string;
}

/**
 * Ranked horizontal bars on one shared baseline, one hue: the form for
 * "compare these named things". The caller decides the order.
 */
export function rankList(rows: RankRow[], opts: { valueWidth?: number } = {}): string {
  const max = Math.max(1, ...rows.map(r => r.value ?? 0));
  const items = rows
    .map(r => {
      const w = r.value && r.value > 0 ? `max(2px,${pct((r.value / max) * 100)})` : "0";
      const figure = r.valueText ?? (r.value === null ? "—" : fmtInt(r.value));
      return (
        `<li${r.dim ? ' class="dim"' : ""}><span class="rk-name"><span class="rk-label">${r.nameHtml}</span>${r.tagsHtml ?? ""}</span>` +
        `<span class="rk-bar"><i style="width:${w}"></i></span>` +
        `${r.spark ?? ""}<span class="rk-val">${esc(figure)}</span>` +
        `${r.extraHtml ? `<span class="rk-extra">${r.extraHtml}</span>` : ""}</li>`
      );
    })
    .join("");
  // A fixed figure column keeps the bars and sparklines of every row aligned.
  const width = opts.valueWidth ? ` style="--vw:${opts.valueWidth}px"` : "";
  return `<ul class="rank"${width}>${items}</ul>`;
}

// ---- stat tile ------------------------------------------------------------

export interface StatTile {
  icon: string;
  label: string;
  /** The window the figure covers, e.g. "近 7 天". */
  period: string;
  value: number | null;
  /** Percent change against the previous window of the same length. */
  deltaPct?: number | null;
  /** An absolute change, for a running total such as stars. */
  deltaAbs?: number | null;
  deltaNote?: string;
  /** A plain line in the delta's place, for a tile whose figure has no "previous period". */
  foot?: string;
  spark?: (number | null)[];
  /** Index where the current period starts in `spark`; earlier bars are the comparison period. */
  sparkAccentFrom?: number;
  href?: string;
}

function deltaHtml(t: StatTile): string {
  const note = t.deltaNote ? `<small>${esc(t.deltaNote)}</small>` : "";
  const render = (n: number, text: string) => {
    const dir = n > 0 ? "up" : n < 0 ? "down" : "flat";
    const arrow = n > 0 ? "▲" : n < 0 ? "▼" : "→";
    return `<div class="t-delta ${dir}">${arrow} ${text}${note}</div>`;
  };
  if (t.foot !== undefined) return `<div class="t-delta none">${esc(t.foot)}</div>`;
  if (t.deltaAbs !== undefined && t.deltaAbs !== null) return render(t.deltaAbs, fmtInt(Math.abs(t.deltaAbs)));
  if (t.deltaPct !== undefined && t.deltaPct !== null) return render(t.deltaPct, growthText(t.deltaPct));
  // No comparison available (the previous window is incomplete or empty): say
  // so rather than print a change computed from half a baseline.
  return `<div class="t-delta none">—${note ? ` ${note}` : ""}</div>`;
}

// A rise past +200% is stated as a multiple ("15.5 倍" for +1451%): against a
// small baseline a four-digit percentage is true but reads as noise.
export function growthText(pct: number): string {
  if (pct >= 200) {
    const times = 1 + pct / 100;
    return `${times >= 100 ? Math.round(times) : Math.round(times * 10) / 10} 倍`;
  }
  return `${Math.abs(Math.round(pct))}%`;
}

export function statTile(t: StatTile): string {
  const inner =
    `<div class="t-label">${icon(t.icon, 15)}<span>${esc(t.label)}</span><small>${esc(t.period)}</small></div>` +
    `<div class="t-val">${t.value === null ? "—" : fmtCompact(t.value)}</div>` +
    deltaHtml(t) +
    (t.spark ? sparkBars(t.spark, { accentFrom: t.sparkAccentFrom }) : "");
  return t.href ? `<a class="tile" href="${esc(t.href)}">${inner}</a>` : `<div class="tile">${inner}</div>`;
}

/**
 * Percent change between two windows, only when both are fully recorded and
 * the baseline is non-zero. Anything else is null: a change against a window
 * with missing days compares two different lengths of time.
 */
export function windowDeltaPct(current: (number | null)[], previous: (number | null)[]): number | null {
  if (current.length === 0 || current.length !== previous.length) return null;
  if (current.some(v => v === null) || previous.some(v => v === null)) return null;
  const cur = sumOrNull(current)!;
  const prev = sumOrNull(previous)!;
  if (prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}
