// Shared SSR chrome for every dashboard page: HTML-escaping, an inline SVG
// sparkline renderer, and the full-document shell (inline CSS only — no
// external stylesheets/fonts/scripts, per the no-external-resources rule).
//
// The CSS custom properties, font stack, and card/table/chip conventions
// below are lifted verbatim from the user-approved mockups in
// design/pages/{overview,project,matrix,todos,posts}.html and
// design/foundations/tokens.html — see those files for the canonical look.

// HTML-escapes a string. Every piece of dynamic (DB- or config-derived) text
// interpolated into a page in src/ui/pages.ts must pass through this first —
// it's the only XSS defense these SSR pages have (no templating engine doing
// it implicitly).
export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function round1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

// A point-in-time annotation for svgSparkline below — src/ui/pages.ts uses
// this to line up an event (a post/todo from src/impact/attribute.ts) with
// the exact x-position of its date in a repoSeries/starSeries array. `index`
// is a position into the same `values` array passed to svgSparkline, not a
// date — the caller (pages.ts) is the one that knows how to map a date to an
// index in a particular series.
export interface SparkMarker {
  index: number;
  label: string;
}

// Inline SVG polyline sparkline, normalized into a `width`x`height` viewBox.
// Returns "" for an empty series (nothing to draw — callers should handle
// that themselves, e.g. render a "暂无数据" fallback instead). A single-value
// series still renders (one point, no visible line) rather than being treated
// as empty. When every value is equal (range 0) the line is drawn flat down
// the vertical center rather than dividing by zero.
//
// `markers` (design doc §5 — "把该项目的事件画成竖线加标签") draws a full-height
// dashed vertical line at each in-range marker's x-position, carrying its
// label as a native SVG <title> tooltip (esc()'d — a post's title is
// DB-derived text). A marker whose `index` falls outside `values` is silently
// dropped rather than clamped — e.g. an event's date exists in the project's
// full star history but isn't within the shorter repo_daily chart window.
export function svgSparkline(values: number[], width = 220, height = 36, markers: SparkMarker[] = []): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const padY = Math.min(4, height / 4);
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = stepX * i;
      const y = height - padY - ((v - min) / range) * (height - padY * 2);
      return `${round1(x)},${round1(y)}`;
    })
    .join(" ");
  const markerSvg = markers
    .filter(m => m.index >= 0 && m.index < values.length)
    .map(m => {
      const x = round1(stepX * m.index);
      return `<line class="marker" x1="${x}" y1="0" x2="${x}" y2="${height}"><title>${esc(m.label)}</title></line>`;
    })
    .join("");
  return (
    `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="趋势走势">` +
    `<line class="base" x1="0" y1="${height - 1}" x2="${width}" y2="${height - 1}"/>` +
    `${markerSvg}` +
    `<polyline class="line" points="${points}"/>` +
    `</svg>`
  );
}

// ~100 lines: shared tokens + rules covering every element used across the
// five page templates (header/nav, cards, tables, chips, priority dots, audit
// list, matrix grid, todo list, sparkline lines). Kept in one place so every
// page renders as one consistent system rather than five near-duplicates.
const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.viz-root {
  --surface-1: #fcfcfb; --page: #f9f9f7; --ink-1: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,.10);
  --series-1: #2a78d6; --good-text: #006300; --pass: #0ca30c; --fail: #d03b3b;
  --p1: #d03b3b; --p2: #ec835a; --p3: #fab219; --posted: #0ca30c;
  --sug-bg: #cde2fb; --sug-ink: #104281;
  background: var(--page); color: var(--ink-1); min-height: 100vh;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root {
    --surface-1: #1a1a19; --page: #0d0d0d; --ink-1: #fff; --ink-2: #c3c2b7;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,.10);
    --series-1: #3987e5; --good-text: #0ca30c; --sug-bg: #184f95; --sug-ink: #cde2fb;
  }
}
:root[data-theme="dark"] .viz-root {
  --surface-1: #1a1a19; --page: #0d0d0d; --ink-1: #fff; --ink-2: #c3c2b7;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,.10);
  --series-1: #3987e5; --good-text: #0ca30c; --sug-bg: #184f95; --sug-ink: #cde2fb;
}
header { display: flex; align-items: baseline; gap: 14px; padding: 20px 28px 0; max-width: 1120px; margin: 0 auto; }
header .logo { font-size: 20px; font-weight: 700; }
header .logo::before { content: "⌂ "; color: var(--series-1); }
header nav { display: flex; gap: 18px; font-size: 14px; color: var(--ink-2); margin-left: auto; }
header nav a { color: inherit; text-decoration: none; padding-bottom: 2px; }
header nav a.active { color: var(--ink-1); font-weight: 600; border-bottom: 2px solid var(--series-1); }
main { max-width: 1120px; margin: 0 auto; padding: 20px 28px 40px; }
h1 { margin: 0 0 4px; font-size: 20px; }
p.lead, p.crumb, p.meta { margin: 0 0 16px; font-size: 13px; color: var(--ink-2); }
p.crumb { font-size: 12.5px; color: var(--muted); margin-bottom: 6px; }
p.meta a { color: var(--series-1); text-decoration: none; }
.fresh { font-size: 12px; color: var(--muted); margin: 6px 0 18px; }
.fresh .dot, .live .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #0ca30c; margin-right: 5px; vertical-align: 1px; }
section.actions, .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; }
section.actions h2, .card h2 { margin: 0 0 4px; font-size: 15px; }
section.actions p.sub, .card p.sub { margin: 0 0 10px; font-size: 12.5px; color: var(--muted); }
ol.todo, ul.plain { list-style: none; margin: 0; padding: 0; }
ol.todo li, ul.plain li { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid var(--grid); font-size: 14px; }
ol.todo li:first-child, ul.plain li:first-child { border-top: 0; }
.pri { flex: 0 0 auto; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--ink-2); }
.pri::before { content: "●"; margin-right: 4px; }
.pri.p1::before { color: var(--p1); } .pri.p2::before { color: var(--p2); } .pri.p3::before { color: var(--p3); }
.src { flex: 0 0 auto; font-size: 11px; color: var(--muted); border: 1px dashed var(--axis); border-radius: 4px; padding: 1px 6px; }
.proj { font-size: 11.5px; color: var(--series-1); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; flex: 0 0 auto; }
.go { margin-left: auto; font-size: 12.5px; color: var(--series-1); text-decoration: none; white-space: nowrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px; }
.card h3 { margin: 0; font-size: 15px; } .card h3 a { color: inherit; text-decoration: none; }
.card .repo { font-size: 11.5px; color: var(--muted); margin: 2px 0 10px; }
.stat-row, .hero { display: flex; align-items: baseline; gap: 8px; }
.hero { gap: 26px; margin: 4px 0 8px; }
.stat-row .big, .hero .n { font-size: 26px; font-weight: 700; }
.stat-row .unit, .hero .l { font-size: 12px; color: var(--ink-2); }
.delta { font-size: 12.5px; font-weight: 600; color: var(--good-text); }
svg .line { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
svg .base { stroke: var(--axis); stroke-width: 1; }
svg .marker { stroke: var(--p2); stroke-width: 1; stroke-dasharray: 2 2; }
.foot { display: flex; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--grid); font-size: 11.5px; color: var(--ink-2); flex-wrap: wrap; }
.chip, .platform { border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; font-size: 11px; color: var(--ink-2); }
.platform { border-radius: 4px; white-space: nowrap; }
.cols { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; align-items: start; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-size: 11px; color: var(--muted); font-weight: 600; padding: 6px 8px 6px 0; border-bottom: 1px solid var(--grid); }
td { padding: 8px 8px 8px 0; border-bottom: 1px solid var(--grid); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom: 0; }
td a.title { color: var(--ink-1); text-decoration: none; font-weight: 550; }
ul.audit { list-style: none; margin: 0; padding: 0; font-size: 13.5px; }
ul.audit li { display: flex; gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--grid); align-items: baseline; }
ul.audit li:last-child { border-bottom: 0; }
.ok::before { content: "✓ "; color: var(--pass); font-weight: 700; }
.bad::before { content: "✗ "; color: var(--fail); font-weight: 700; }
.na { color: var(--muted); } .na::before { content: "— "; }
.matrix-table th, .matrix-table td { text-align: center; white-space: nowrap; padding: 9px 10px; }
.matrix-table thead th { font-size: 11px; color: var(--muted); font-weight: 600; }
.matrix-table thead th .lang { display: block; font-weight: 400; }
.matrix-table tbody th { text-align: left; font-weight: 600; position: sticky; left: 0; background: var(--surface-1); }
.posted { color: var(--posted); font-weight: 700; }
.planned { color: var(--ink-2); }
.sug { display: inline-block; min-width: 34px; padding: 2px 7px; border-radius: 999px; background: var(--sug-bg); color: var(--sug-ink); font-weight: 700; font-size: 12px; }
.legend { display: flex; gap: 16px; font-size: 12px; color: var(--ink-2); margin-bottom: 12px; }
.filters { display: flex; gap: 8px; margin-bottom: 14px; font-size: 12.5px; }
.filters a, .filters button { font: inherit; text-decoration: none; border: 1px solid var(--border); background: var(--surface-1); color: var(--ink-2); border-radius: 999px; padding: 3px 12px; cursor: pointer; }
.filters a.on, .filters button.on { color: var(--ink-1); font-weight: 600; border-color: var(--series-1); }
li.done { color: var(--muted); } li.done .title { text-decoration: line-through; }
li.done .effect { margin-left: auto; font-size: 12px; color: var(--good-text); white-space: nowrap; }
.sec-cap { font-size: 12px; color: var(--muted); font-weight: 600; margin: 14px 0 4px; }
.hint { font-size: 12px; color: var(--muted); margin-top: 10px; }
input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--series-1); flex: 0 0 auto; }
/* A <form> wrapping controls that must lay out as if the form tag weren't
   there at all — e.g. a todo row's checkbox+button inside a flex <li>, or a
   matrix cell's <select>+button inside a centered <td>. display:contents
   removes the form's own box from layout entirely, letting its children
   participate directly in the parent's flex/grid, matching the exact
   layout the equivalent non-form (disabled/static) markup already had. */
form.blend { display: contents; }
button.go, button.navlink { border: 0; background: none; padding: 0; font: inherit; cursor: pointer; }
button.go { color: var(--series-1); }
header nav button.navlink { color: inherit; padding-bottom: 2px; }
.cell-select { font: inherit; font-size: 11px; padding: 1px 2px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-1); color: var(--ink-1); max-width: 96px; }
.cell-go { font: inherit; font-size: 11px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-1); color: var(--ink-2); cursor: pointer; padding: 1px 5px; margin-left: 3px; }
.card-form { display: flex; flex-direction: column; gap: 8px; max-width: 360px; margin-top: 4px; }
.card-form label { font-size: 12px; color: var(--muted); margin-top: 4px; }
.card-form input, .card-form select { font: inherit; font-size: 13.5px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--page); color: var(--ink-1); }
button.primary { font: inherit; font-size: 13.5px; padding: 6px 14px; border: none; border-radius: 6px; background: var(--series-1); color: #fff; cursor: pointer; align-self: flex-start; margin-top: 4px; }
.error-text { color: var(--fail); font-size: 13px; margin: 0 0 12px; }
details.add-post { margin-bottom: 16px; }
details.add-post summary { cursor: pointer; font-weight: 600; color: var(--series-1); list-style: none; }
details.add-post summary::-webkit-details-marker { display: none; }
details.add-post[open] summary { margin-bottom: 4px; }
/* Impact rows. The two windows sit side by side with an arrow between them so
   before→after reads as one movement rather than two unrelated figures. The
   "统计中" note is styled as a warning (not muted) because an incomplete
   window is the one state a reader must not skim past as a settled zero. */
ol.impact { list-style: none; margin: 0; padding: 0; }
ol.impact li { padding: 14px 0; border-top: 1px solid var(--grid); }
ol.impact li:first-child { border-top: 0; }
.ev-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; }
.ev-date { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.ev-title { font-weight: 550; }
.ev-title a { color: inherit; text-decoration: none; }
.ev-title a:hover { color: var(--series-1); }
.ev-title.pending, .ev-title.partial { color: var(--ink-2); font-weight: 500; }
.ev-wins { display: flex; align-items: center; gap: 14px; margin-top: 8px; flex-wrap: wrap; }
.ev-arrow { color: var(--muted); font-size: 15px; }
.win { border: 1px solid var(--border); border-radius: 8px; padding: 7px 12px; min-width: 190px; }
.win-h { font-size: 11px; color: var(--muted); display: flex; gap: 6px; align-items: baseline; }
.win-n { display: flex; gap: 12px; font-size: 13px; margin-top: 2px; font-variant-numeric: tabular-nums; }
.win-note { color: var(--p2); font-weight: 600; }
`;

// Full HTML document shell: doctype, head (charset/viewport/title/inline
// CSS), and `body` wrapped in the `.viz-root` container the CSS above themes.
// `title` is escaped (it's often derived from a project name); `body` is
// trusted pre-built HTML from src/ui/pages.ts (which itself escapes every
// dynamic value it interpolates).
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="viz-root">
${body}
</div>
</body>
</html>`;
}
