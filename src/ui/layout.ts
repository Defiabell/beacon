// Shared SSR chrome for every dashboard page: HTML-escaping and the
// full-document shell (inline CSS only — no external stylesheets/fonts/scripts,
// per the no-external-resources rule). Charts are built in src/ui/charts.ts;
// their styles live in the CSS below.
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
  --series-1-hi: #5598e7; --bad-text: #b42323; --wash: rgba(11,11,11,.045); --hover: rgba(11,11,11,.07);
  background: var(--page); color: var(--ink-1); min-height: 100vh;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root {
    --surface-1: #1a1a19; --page: #0d0d0d; --ink-1: #fff; --ink-2: #c3c2b7;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,.10);
    --series-1: #3987e5; --good-text: #0ca30c; --sug-bg: #184f95; --sug-ink: #cde2fb;
    --series-1-hi: #6da7ec; --bad-text: #e66767; --wash: rgba(255,255,255,.055); --hover: rgba(255,255,255,.09);
  }
}
:root[data-theme="dark"] .viz-root {
  --surface-1: #1a1a19; --page: #0d0d0d; --ink-1: #fff; --ink-2: #c3c2b7;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,.10);
  --series-1: #3987e5; --good-text: #0ca30c; --sug-bg: #184f95; --sug-ink: #cde2fb;
    --series-1-hi: #6da7ec; --bad-text: #e66767; --wash: rgba(255,255,255,.055); --hover: rgba(255,255,255,.09);
}
/* Full-width bar whose content lines up with <main>'s 1120px column: the side
   padding grows with the viewport instead of the bar being a centered box. */
header { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px;
  padding: 10px max(28px, calc((100% - 1120px) / 2 + 28px)); background: var(--page); border-bottom: 1px solid var(--border); }
header .logo { display: inline-flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 700; letter-spacing: -.01em; }
header .logo .ico { color: #fff; background: var(--series-1); border-radius: 7px; padding: 4px; box-sizing: content-box; }
header nav { display: flex; align-items: center; gap: 2px; font-size: 13.5px; color: var(--ink-2); margin-left: auto; overflow-x: auto; scrollbar-width: none; }
header nav::-webkit-scrollbar { display: none; }
header nav a, header nav button.navlink { display: inline-flex; align-items: center; gap: 6px; color: inherit; text-decoration: none; padding: 6px 10px; border-radius: 8px; white-space: nowrap; }
header nav a:hover, header nav button.navlink:hover { background: var(--wash); color: var(--ink-1); }
header nav a.active { color: var(--sug-ink); background: var(--sug-bg); font-weight: 600; }
main { max-width: 1120px; margin: 0 auto; padding: 22px 28px 48px; }
h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: -.01em; }
.ico { flex: 0 0 auto; vertical-align: -3px; }
h2 .ico, .t-label .ico { color: var(--series-1); }
p.lead, p.crumb, p.meta { margin: 0 0 16px; font-size: 13px; color: var(--ink-2); }
p.crumb { font-size: 12.5px; color: var(--muted); margin-bottom: 6px; }
p.meta a { color: var(--series-1); text-decoration: none; }
.fresh { font-size: 12px; color: var(--muted); margin: 6px 0 18px; }
.fresh .dot, .live .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #0ca30c; margin-right: 5px; vertical-align: 1px; }
section.actions, .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; }
section.actions h2, .card h2 { margin: 0 0 4px; font-size: 15px; display: flex; align-items: center; gap: 7px; }
/* A heading's right-hand link ("看每日趋势 →"). */
h2 .more { margin-left: auto; font-size: 12.5px; font-weight: 400; color: var(--series-1); text-decoration: none; white-space: nowrap; }
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
.foot { display: flex; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--grid); font-size: 11.5px; color: var(--ink-2); flex-wrap: wrap; }
.chip, .platform { border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; font-size: 11px; color: var(--ink-2); }
.platform { border-radius: 4px; white-space: nowrap; }
.cols { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; align-items: start; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
/* Grid items default to min-width:auto, so one wide child (a table, a chart)
   would stretch its column past a phone screen instead of scrolling inside it. */
.cols > *, .two > *, .grid > * { min-width: 0; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-size: 11px; color: var(--muted); font-weight: 600; padding: 6px 8px 6px 0; border-bottom: 1px solid var(--grid); }
td { padding: 8px 8px 8px 0; border-bottom: 1px solid var(--grid); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
/* A figure we could not refresh. Dimmed so a table of dashes reads as "not
   collected" at a glance instead of as a row of zeroes; the cell's title
   attribute carries the last known value and its date. */
td.num.stale { color: var(--dim, #999); }
tr:last-child td { border-bottom: 0; }
td a.title { color: var(--ink-1); text-decoration: none; font-weight: 550; }
ul.audit { list-style: none; margin: 0; padding: 0; font-size: 13.5px; }
ul.audit li { display: flex; gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--grid); align-items: baseline; }
ul.audit li:last-child { border-bottom: 0; }
ul.audit li .chip { min-width: 0; overflow-wrap: anywhere; }
.ok::before { content: "✓ "; color: var(--pass); font-weight: 700; }
.bad::before { content: "✗ "; color: var(--fail); font-weight: 700; }
.na { color: var(--muted); } .na::before { content: "— "; }
.matrix-table th, .matrix-table td { text-align: center; white-space: nowrap; padding: 9px 10px; }
.matrix-table thead th { font-size: 11px; color: var(--muted); font-weight: 600; }
.matrix-table thead th .lang { display: block; font-weight: 400; }
/* The channel name in the header is a link out to the channel itself. Dotted
   underline rather than a full link color: it must not out-shout the coverage
   marks in the cells below, which are what the table is actually about. */
.matrix-table thead th a.ch-name { color: var(--ink-2); text-decoration: none; border-bottom: 1px dotted var(--border); }
.matrix-table thead th a.ch-name:hover { color: var(--ink-1); }
.matrix-table tbody th { text-align: left; font-weight: 600; position: sticky; left: 0; background: var(--surface-1); }
.posted { color: var(--posted); font-weight: 700; }
/* A posted cell's attached effect (design doc §5 / review item 2) — small and
   muted so it reads as supporting detail under the ✓, not a competing number. */
.cell-effect { font-size: 10px; font-weight: 400; color: var(--ink-2); white-space: normal; margin-top: 2px; }
/* The referral line outranks .cell-effect — it is attributed by construction,
   where the effect line is a time window that can absorb a neighbour's wave.
   Rendered darker/heavier so the eye lands on the trustworthy number first. */
.cell-referred { font-size: 10px; font-weight: 600; color: var(--ink-1); white-space: normal; margin-top: 2px; }
.cell-referred.zero { font-weight: 400; color: var(--ink-2); }
.cell-referred.unmeasured { font-weight: 400; color: var(--ink-2); font-style: italic; }
.cell-warn { font-size: 10px; font-weight: 600; color: var(--p1); white-space: normal; }
/* A surface nobody has arrived from is still rendered — dimmed, not hidden,
   because the zero is the finding. */
ul.plain li.dim { color: var(--muted); }
ul.plain li .effect { margin-left: auto; font-variant-numeric: tabular-nums; }
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
/* 「怎么发」— the always-visible per-channel instructions under the matrix.
   :target highlights the one <li> an overview suggestion deep-linked to, so the
   jump lands somewhere visibly, not just somewhere. */
section.howto { margin-top: 28px; }
.howto-group { margin-top: 18px; }
.howto-group h3 { font-size: 13px; margin: 0 0 3px; }
ul.ch-list { list-style: none; margin: 8px 0 0; padding: 0; }
ul.ch-list li { padding: 9px 8px; border-bottom: 1px solid var(--grid); border-radius: 5px; }
ul.ch-list li:last-child { border-bottom: 0; }
ul.ch-list li:target { background: var(--sug-bg); }
ul.ch-list a { font-size: 13.5px; color: var(--ink-1); font-weight: 550; text-decoration: none; }
ul.ch-list a:hover { text-decoration: underline; }
.lang-inline { margin-left: 7px; font-size: 11px; color: var(--muted); }
ul.ch-list p { margin: 4px 0 0; font-size: 12.5px; color: var(--ink-2); line-height: 1.6; }
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
header nav button.navlink { color: inherit; }
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
.ev-attr { font-size: 12.5px; margin-top: 7px; padding-left: 10px; border-left: 2px solid var(--axis); color: var(--ink-2); }
.ev-attr.attr-referred { border-left-color: var(--pass); color: var(--good-text); }
.ev-attr.attr-no-referral { border-left-color: var(--fail); color: var(--fail); }
.ev-attr.attr-unobservable, .ev-attr.attr-predates-coverage, .ev-attr.attr-not-a-channel { color: var(--muted); }
.win { border: 1px solid var(--border); border-radius: 8px; padding: 7px 12px; min-width: 190px; }
.win-h { font-size: 11px; color: var(--muted); display: flex; gap: 6px; align-items: baseline; }
.win-n { display: flex; gap: 12px; font-size: 13px; margin-top: 2px; font-variant-numeric: tabular-nums; }
.win-note { color: var(--p2); font-weight: 600; }

/* ---- stat tiles ---------------------------------------------------------- */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
.tile { display: block; background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px 12px; color: inherit; text-decoration: none; min-width: 0; }
a.tile:hover { border-color: var(--series-1); }
.t-label { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ink-2); white-space: nowrap; }
.t-label small { margin-left: auto; font-size: 11px; color: var(--muted); }
/* Proportional figures: tabular-nums makes a large standalone number look loose. */
.t-val { font-size: 28px; font-weight: 650; line-height: 1.15; margin-top: 8px; letter-spacing: -.015em; }
.t-delta { font-size: 12px; font-weight: 600; margin-top: 2px; white-space: nowrap; }
.t-delta.up { color: var(--good-text); } .t-delta.down { color: var(--bad-text); }
.t-delta.flat, .t-delta.none { color: var(--muted); font-weight: 400; }
.t-delta small { font-weight: 400; color: var(--muted); margin-left: 6px; font-size: 11.5px; }
.tile .spark { margin-top: 10px; height: 28px; }

/* ---- sparkline bars ------------------------------------------------------ */
.spark { display: flex; align-items: flex-end; gap: 2px; height: 22px; }
.spark i { display: block; flex: 1 1 0; min-width: 1px; max-width: 10px; background: var(--series-1); border-radius: 1.5px 1.5px 0 0; }
/* The comparison period recedes; the current one carries the accent. */
.spark i.prev { background: var(--axis); }
.spark i.miss { height: 100%; background: var(--wash); border-radius: 0; }

/* ---- day chart (src/ui/charts.ts) ---------------------------------------- */
.chart { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 8px; row-gap: 5px; margin-top: 12px; }
.chart.mini { grid-template-columns: minmax(0, 1fr); margin-top: 6px; }
.yax { position: relative; height: var(--h); font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.yax span { position: absolute; right: 0; transform: translateY(50%); line-height: 1; }
.plot { position: relative; height: var(--h); border-bottom: 1px solid var(--axis); }
.gl { position: absolute; left: 0; right: 0; border-top: 1px solid var(--grid); }
.days { position: absolute; inset: 0; display: flex; }
/* The whole day slot is the hover target, not the painted bar. */
.col { flex: 1 1 0; min-width: 0; position: relative; display: flex; align-items: flex-end; justify-content: center; }
/* A day with no record: a wash, so it cannot be read as a zero. */
.col.miss { background: var(--wash); }
.col:hover { background: var(--hover); }
.bar { display: block; width: calc(100% - 2px); max-width: 24px; min-width: 1px; background: var(--series-1); border-radius: 3px 3px 0 0; }
.chart.mini .bar { border-radius: 2px 2px 0 0; }
.col:hover .bar { background: var(--series-1-hi); }
.ln { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.ln polyline { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.pt { display: none; position: absolute; left: 50%; width: 8px; height: 8px; margin: 0 0 -4px -4px; border-radius: 50%; background: var(--series-1); box-shadow: 0 0 0 2px var(--surface-1); }
.pt.end, .col:hover .pt { display: block; }
.chart.k-line .col:hover::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; border-left: 1px solid var(--axis); }
/* An event (a post, a finished todo) on its day. */
.marker { position: absolute; top: 0; bottom: 0; left: 50%; border-left: 1px solid var(--p2); }
.marker::before { content: ""; position: absolute; top: -3px; left: -3.5px; width: 6px; height: 6px; border-radius: 50%; background: var(--p2); }
.tip { display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); z-index: 20; flex-direction: column; gap: 2px;
  padding: 7px 10px; border-radius: 8px; background: var(--ink-1); color: var(--page); font-size: 12px; line-height: 1.35; white-space: nowrap; pointer-events: none; box-shadow: 0 4px 14px rgba(0,0,0,.18); }
.col:hover .tip { display: flex; }
.col.tl .tip { left: 0; transform: none; } .col.tr .tip { left: auto; right: 0; transform: none; }
.tip-date { opacity: .7; font-size: 11px; }
.tip-row { display: flex; align-items: baseline; gap: 6px; }
.tip-row b { font-weight: 650; font-variant-numeric: tabular-nums; min-width: 2ch; }
.tip-ev { max-width: 240px; white-space: normal; padding-top: 3px; margin-top: 2px; border-top: 1px solid color-mix(in srgb, var(--page) 25%, transparent); }
.xax { grid-column: 2; display: flex; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.xax span { flex: 1 1 0; min-width: 0; display: flex; justify-content: center; white-space: nowrap; }
/* The last day's label ends at the plot's right edge instead of overhanging it. */
.xax span.r { justify-content: flex-end; }
.chart.mini .xax { grid-column: 1; justify-content: space-between; font-size: 10.5px; }
.xax.ends span { flex: 0 0 auto; }
.chart-note { font-size: 11.5px; color: var(--muted); margin: 8px 0 0; }
.chart-note .key { display: inline-block; width: 10px; height: 10px; background: var(--wash); border: 1px solid var(--border); vertical-align: -1px; margin-right: 5px; }
.chart-note .key.ev { width: 0; height: 11px; border: 0; border-left: 1px solid var(--p2); margin-left: 12px; }

/* ---- small multiples ----------------------------------------------------- */
.multi { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px 20px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--grid); }
.sm { min-width: 0; }
.sm-h { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; }
.sm-h .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-1); font-weight: 550; text-decoration: none; }
.sm-h a.name:hover { color: var(--series-1); }
.sm-h b { margin-left: auto; font-weight: 650; font-variant-numeric: tabular-nums; }
.rest { font-size: 12px; color: var(--muted); margin: 14px 0 0; line-height: 1.7; }

/* ---- ranked bars --------------------------------------------------------- */
ul.rank { list-style: none; margin: 0; padding: 0; }
ul.rank li { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; padding: 8px 0; border-top: 1px solid var(--grid); font-size: 13.5px; }
ul.rank li:first-child { border-top: 0; }
ul.rank li.dim { color: var(--muted); }
.rk-name { flex: 0 0 32%; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }
.rk-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rk-name a { color: inherit; text-decoration: none; } .rk-name a:hover { color: var(--series-1); }
.rk-bar { flex: 1 1 0; min-width: 40px; height: 8px; }
.rk-bar i { display: block; height: 100%; background: var(--series-1); border-radius: 0 4px 4px 0; }
ul.rank .spark { flex: 0 0 72px; height: 18px; }
.rk-val { flex: 0 0 auto; min-width: var(--vw, 72px); text-align: right; font-variant-numeric: tabular-nums; font-weight: 550; }
.rk-extra { flex: 0 0 100%; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
/* Chips inside a row may shrink and wrap: .src is nowrap-and-rigid elsewhere,
   which pushes a long host list off a phone screen. */
.rk-extra > *, .rk-name > .src, .rk-name > .chip { flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; }
details.fold { margin-top: 8px; font-size: 12.5px; color: var(--muted); }
details.fold summary { cursor: pointer; padding: 4px 0; }
details.fold[open] summary { margin-bottom: 4px; }

/* ---- project cards ------------------------------------------------------- */
.card > .spark { height: 30px; margin-top: 10px; }
.card > .spark i { max-width: none; }
.meter { height: 8px; border-radius: 4px; overflow: hidden; margin: 2px 0 10px; background: color-mix(in srgb, var(--pass) 20%, var(--surface-1)); }
.meter i { display: block; height: 100%; background: var(--pass); }

/* ---- daily table --------------------------------------------------------- */
table.daily td, table.daily th { white-space: nowrap; }
table.daily .d-up { color: var(--good-text); font-size: 11.5px; margin-left: 5px; }
table.daily td.none { color: var(--muted); }

@media (max-width: 720px) {
  header { padding: 8px 16px; }
  header nav { margin-left: 0; flex: 0 0 100%; }
  main { padding: 16px 16px 40px; }
  .cols { grid-template-columns: 1fr; }
  .two { grid-template-columns: 1fr; }
  .rk-name { flex: 0 0 100%; }
  .t-val { font-size: 24px; }
}
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
