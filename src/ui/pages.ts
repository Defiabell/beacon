// Five SSR page renderers, one per route in Task 12's router. Every function
// returns a complete HTML document (via layout.page) ready to hand back in a
// Response. All dynamic (DB-, GitHub-, or user-submitted-) text passes through
// esc() before being interpolated — see src/ui/layout.ts for that contract.
//
// Look & feel follows design/pages/{overview,project,matrix,todos,posts}.html
// verbatim (class names, layout). See task-12-report.md for the handful of
// deliberate deviations where the data available from src/api/public.ts
// doesn't (yet) carry what the mockup shows.
import type { Overview, ProjectDetail, MatrixData, MatrixCoverageRow, MatrixEffect, PostWithMetrics, ProjectSummary } from "../api/public";
import type { Todo, SourceRun, ReferrerRow, CheckResult, Platform } from "../types";
import type { EventImpact, ImpactWindow } from "../impact/attribute";
import { CONFIG } from "../config";
import { page, svgSparkline, esc, type SparkMarker } from "./layout";

type NavKey = "overview" | "matrix" | "todos" | "posts" | "impact" | null;

const SOURCE_LABELS: Record<string, string> = { audit: "体检", matrix: "矩阵", manual: "手动" };
const SOURCE_NAMES: Record<string, string> = { github: "GitHub", posts: "帖子", goatcounter: "GoatCounter", audit: "体检" };
const PLATFORM_LABELS: Record<Platform, string> = { v2ex: "V2EX", linuxdo: "LinuxDO", hn: "HN", reddit: "Reddit" };
const CHECK_LABELS: Record<string, string> = {
  description: "description ≥ 20 字符",
  topics: "topics ≥ 3 个",
  license: "LICENSE",
  "readme-english-intro": "README 英文简介",
  "readme-visual": "README 含截图",
  "release-assets": "Release 产物",
  "readme-links": "README 链接可用",
  "social-preview": "social preview 图",
  homepage: "homepage 字段"
};

function sourceLabel(s: string): string {
  return SOURCE_LABELS[s] ?? s;
}

// Login/logout affordance shared by every page's header (navHeader below, and
// renderProject's own simpler header). Logged out: a plain GET link to the
// login form. Logged in: a POST /logout form — logout is a state change (it
// clears a cookie), so per the project's no-JS/forms-only rule it must be a
// real form submission, not a GET link; `form.blend` (src/ui/layout.ts) makes
// it lay out as if it were just the <button> itself, so it sits inline with
// the other nav <a> links.
function authLink(authed: boolean): string {
  return authed
    ? `<form method="post" action="/logout" class="blend"><button type="submit" class="navlink">登出</button></form>`
    : `<a href="/login">登录</a>`;
}

// Shared header/nav. Nav links + active-page highlighting are identical
// across overview/matrix/todos/posts; the project detail page uses a
// simpler "← 返回总览" nav instead (matches design/pages/project.html), so it
// builds its own header rather than calling this.
function navHeader(active: NavKey, authed: boolean): string {
  const link = (href: string, label: string, key: NavKey) =>
    `<a${key === active ? ' class="active"' : ""} href="${href}">${label}</a>`;
  return (
    `<header><span class="logo">beacon</span><nav>` +
    `${link("/", "总览", "overview")}${link("/matrix", "渠道矩阵", "matrix")}` +
    `${link("/todos", "待办", "todos")}${link("/posts", "帖子", "posts")}${link("/impact", "效果", "impact")}` +
    `${authLink(authed)}` +
    `</nav></header>`
  );
}

function projectTagsLabel(name: string): string {
  const p = CONFIG.projects.find(p => p.name === name);
  return p ? p.tags.join(" / ") : "";
}

function deltaArrow(n: number): string {
  const arrow = n > 0 ? "▲" : n < 0 ? "▼" : "→";
  return `${arrow} ${Math.abs(n)}`;
}

function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : String(n);
}

// SQLite datetime('now')/ISO timestamps both start "YYYY-MM-DD..."; trimming
// to 16 chars gives a stable "YYYY-MM-DD HH:MM" regardless of which format
// produced the string, without pulling in a date-parsing dependency.
function fmtDateTime(s: string): string {
  return s.replace("T", " ").slice(0, 16);
}

function fmtDate(s: string): string {
  return s.slice(0, 10);
}

// ---- overview -------------------------------------------------------------

function freshnessBar(sources: SourceRun[]): string {
  if (sources.length === 0) {
    return `<p class="fresh"><span class="dot"></span>暂无数据更新记录</p>`;
  }
  const latest = sources.reduce((a, b) => (a.lastRunAt > b.lastRunAt ? a : b));
  const parts = sources.map(s => `${esc(SOURCE_NAMES[s.source] ?? s.source)} ${s.ok ? "✓" : "✗"}`).join(" · ");
  return `<p class="fresh"><span class="dot"></span>数据更新于 ${esc(fmtDateTime(latest.lastRunAt))} · ${parts}</p>`;
}

interface ActionItem {
  priLabel: string;
  priClass: string;
  srcLabel: string;
  title: string;
  href: string;
  linkLabel: string;
}

const ACTION_ITEMS_LIMIT = 5;

// 「本周建议行动」= top open todos first, then top scored channel suggestions
// filling any remaining slots up to 5 total (both inputs already arrive
// priority/score-sorted from src/api/public.ts's buildOverview).
function actionItems(o: Overview): ActionItem[] {
  const todoItems: ActionItem[] = o.topTodos.slice(0, ACTION_ITEMS_LIMIT).map(t => ({
    priLabel: `P${t.priority}`,
    priClass: `p${t.priority}`,
    srcLabel: sourceLabel(t.source),
    title: t.title,
    href: `/p/${encodeURIComponent(t.project)}`,
    linkLabel: "去修复 →"
  }));
  const remaining = ACTION_ITEMS_LIMIT - todoItems.length;
  const suggestionItems: ActionItem[] =
    remaining > 0
      ? o.suggestions.slice(0, remaining).map(s => ({
          priLabel: "",
          priClass: "",
          srcLabel: "矩阵",
          title: `${s.project} → ${s.channelName}（适配分 ${s.score}）`,
          href: "/matrix",
          linkLabel: "看渠道 →"
        }))
      : [];
  return [...todoItems, ...suggestionItems];
}

function renderActionItem(item: ActionItem): string {
  const pri = item.priLabel ? `<span class="pri ${item.priClass}">${item.priLabel}</span>` : "";
  return (
    `<li>${pri}<span class="src">${esc(item.srcLabel)}</span>${esc(item.title)}` +
    `<a class="go" href="${item.href}">${item.linkLabel}</a></li>`
  );
}

// ProjectSummary carries no time-series data (that only exists on
// ProjectDetail.repoSeries/starSeries) — deliberately no sparkline on the
// overview cards, per task-12-brief; the project detail page has the real
// chart. See task-12-report.md.
function projectCard(p: ProjectSummary): string {
  const tags = projectTagsLabel(p.project);
  const referrerChip = p.topReferrers.length > 0 ? `<span class="chip">来源 ${esc(p.topReferrers[0].referrer)}</span>` : "";
  // Review item 1 (design doc §3): clones14d is human-only — a nonzero
  // machineClones14d is disclosed right next to it, never folded in.
  const machineNote = p.machineClones14d > 0 ? `（另有 ${p.machineClones14d} 次机器 clone）` : "";
  return `<div class="card">
<h3><a href="/p/${encodeURIComponent(p.project)}">${esc(p.project)}</a></h3>
<p class="repo">${esc(p.repo)}${tags ? " · " + esc(tags) : ""}</p>
<div class="stat-row"><span class="big">${p.stars}</span><span class="unit">stars</span><span class="delta">${deltaArrow(p.starsDelta7d)} 本周</span></div>
<div class="foot"><span class="chip">views 14d ${p.views14d}</span><span class="chip">clones 14d ${p.clones14d}${machineNote}</span><span class="chip">帖子 ${p.postCount}</span>${referrerChip}</div>
</div>`;
}

export function renderOverview(o: Overview, authed: boolean): string {
  const actions = actionItems(o).map(renderActionItem).join("") || `<li>暂无待办建议</li>`;
  const cards = o.projects.map(projectCard).join("") || `<p class="sub">暂无项目</p>`;
  const body = `${navHeader("overview", authed)}
<main>
${freshnessBar(o.sources)}
<section class="actions">
<h2>本周建议行动</h2>
<p class="sub">来自曝光体检与渠道矩阵，按优先级排序——做完一条，曲线会告诉你值不值。</p>
<ol class="todo">${actions}</ol>
</section>
<div class="grid">${cards}</div>
</main>`;
  return page("beacon · 总览", body);
}

// ---- project detail --------------------------------------------------------

function renderAuditItem(a: CheckResult & { checkedAt: string }): string {
  const cls = a.status === "pass" ? "ok" : a.status === "fail" ? "bad" : "na";
  const label = CHECK_LABELS[a.checkId] ?? a.checkId;
  // .chip is a bordered pill, so an empty one still renders — only emit it when there is detail.
  const chip = a.detail ? `<span class="chip">${esc(a.detail)}</span>` : "";
  return `<li class="${cls}">${esc(label)}${chip}</li>`;
}

function renderReferrersTable(rows: ReferrerRow[]): string {
  if (rows.length === 0) return `<p class="sub">暂无数据</p>`;
  const trs = rows
    .map(r => `<tr><td>${esc(r.referrer)}</td><td class="num">${r.count}</td><td class="num">${r.uniques}</td></tr>`)
    .join("");
  return `<div class="scroll"><table><tr><th>来源</th><th class="num">次数</th><th class="num">独立</th></tr>${trs}</table></div>`;
}

// Shared by the project-detail post table (no 项目/发布 columns) and the
// standalone /posts page (both columns shown) — see renderPosts below.
function postsTable(rows: PostWithMetrics[], opts: { showProject: boolean; showDate: boolean }): string {
  if (rows.length === 0) return `<p class="sub">暂无帖子</p>`;
  const head =
    `<th>帖子</th>${opts.showProject ? "<th>项目</th>" : ""}<th>平台</th>` +
    `<th class="num">回复</th><th class="num">浏览</th><th class="num">赞/分</th>${opts.showDate ? "<th>发布</th>" : ""}`;
  const body = rows
    .map(r => {
      const title = esc(r.post.title || r.post.url);
      const platform = PLATFORM_LABELS[r.post.platform] ?? r.post.platform;
      const scoreLike = r.latest?.likes ?? r.latest?.score ?? null;
      return (
        `<tr><td><a class="title" href="${esc(r.post.url)}" target="_blank" rel="noopener">${title}</a></td>` +
        `${opts.showProject ? `<td class="proj">${esc(r.post.project)}</td>` : ""}` +
        `<td><span class="platform">${esc(platform)}</span></td>` +
        `<td class="num">${fmtNum(r.latest?.replies)}</td><td class="num">${fmtNum(r.latest?.views)}</td>` +
        `<td class="num">${fmtNum(scoreLike)}</td>` +
        `${opts.showDate ? `<td>${r.post.publishedAt ? esc(fmtDate(r.post.publishedAt)) : "—"}</td>` : ""}</tr>`
      );
    })
    .join("");
  return `<div class="scroll"><table><tr>${head}</tr>${body}</table></div>`;
}

// Maps each event onto its index in a dated series so svgSparkline can draw a
// vertical marker there — the point of the whole feature is that a spike and
// the action that caused it line up visually. An event whose date isn't in
// this particular series (older than the chart window, or a day GitHub never
// reported) is dropped rather than clamped to an edge: a marker on the wrong
// day would assert a causal link that isn't there.
function eventMarkers(events: EventImpact[] | undefined, dates: string[]): SparkMarker[] {
  if (!events) return [];
  const indexOfDate = new Map(dates.map((d, i) => [d, i]));
  return events.flatMap(e => {
    const index = indexOfDate.get(e.event.date);
    return index === undefined ? [] : [{ index, label: `${e.event.date} ${e.event.title}` }];
  });
}

export function renderProject(name: string, d: ProjectDetail, authed: boolean): string {
  const s = d.summary;
  const failCount = d.audit.filter(a => a.status === "fail").length;
  const starMarks = eventMarkers(d.events, d.starSeries.map(r => r.date));
  const repoMarks = eventMarkers(d.events, d.repoSeries.map(r => r.date));
  const starSpark = svgSparkline(d.starSeries.map(r => r.stars), 640, 90, starMarks);
  const viewsSpark = svgSparkline(d.repoSeries.map(r => r.views), 300, 48, repoMarks);
  const clonesSpark = svgSparkline(d.repoSeries.map(r => r.clones), 300, 48, repoMarks);
  const header = `<header><span class="logo">beacon</span><nav><a href="/">← 返回总览</a>${authLink(authed)}</nav></header>`;
  // Review item 1: same human/machine disclosure as the overview card (see
  // projectCard) — the clone curve below stays raw/unfiltered (design doc §3
  // never touches repo_daily itself), this note just labels what the "clones
  // · 14d" figure right above it actually counts.
  const machineCloneNote = s.machineClones14d > 0 ? `<p class="sub">另有 ${s.machineClones14d} 次机器 clone</p>` : "";

  const body = `${header}
<main>
<p class="crumb">总览 / 项目</p>
<h1>${esc(name)}</h1>
<p class="meta"><a href="https://github.com/${esc(s.repo)}" target="_blank" rel="noopener">github.com/${esc(s.repo)}</a> · ${esc(projectTagsLabel(name))}</p>
<div class="cols">
<div>
<div class="card">
<h2>Star 增长</h2>
<p class="sub">累计 star 数（stargazer 时间戳回填）</p>
<div class="hero"><div><div class="n">${s.stars}</div><div class="l">stars</div></div><div><div class="delta">${deltaArrow(s.starsDelta7d)}</div><div class="l">近 7 天</div></div></div>
${starSpark || `<p class="sub">暂无数据</p>`}
</div>
<div class="card">
<h2>仓库流量 · 近 ${d.repoSeries.length} 天</h2>
<p class="sub">GitHub traffic（每日采集累积）</p>
<div class="two">
<div><div class="hero"><div><div class="n">${s.views14d}</div><div class="l">views · 14d</div></div></div>${viewsSpark}</div>
<div><div class="hero"><div><div class="n">${s.clones14d}</div><div class="l">clones · 14d</div></div></div>${machineCloneNote}${clonesSpark}</div>
</div>
</div>
<div class="card">
<h2>帖子表现</h2>
${postsTable(d.posts, { showProject: false, showDate: false })}
</div>
</div>
<div>
<div class="card">
<h2>流量来源</h2>
<p class="sub">referrers · 最新快照</p>
${renderReferrersTable(d.referrers)}
</div>
<div class="card">
<h2>曝光体检</h2>
<p class="sub">${d.audit.length} 项检查 · ${failCount} 项待修</p>
<ul class="audit">${d.audit.map(renderAuditItem).join("") || `<li class="na">暂无体检数据</li>`}</ul>
</div>
</div>
</div>
</main>`;
  return page(`beacon · ${name}`, body);
}

// ---- matrix ----------------------------------------------------------------

const LANG_LABELS: Record<string, string> = { zh: "中", en: "英" };

export function renderMatrix(m: MatrixData, authed: boolean): string {
  const covByKey = new Map(m.coverage.map(c => [`${c.project}:${c.channelId}`, c]));
  const sugByKey = new Map(m.suggestions.map(s => [`${s.project}:${s.channelId}`, s.score]));

  const headCells = m.channels
    .map(c => `<th>${esc(c.name)}<span class="lang">${esc(LANG_LABELS[c.lang] ?? c.lang)}</span></th>`)
    .join("");

  const rows = m.projects
    .map(projectName => {
      const cells = m.channels
        .map(c => {
          const cov = covByKey.get(`${projectName}:${c.id}`);
          const score = sugByKey.get(`${projectName}:${c.id}`);
          return authed ? matrixFormCell(projectName, c, cov, score) : matrixStaticCell(cov, score);
        })
        .join("");
      return `<tr><th>${esc(projectName)}</th>${cells}</tr>`;
    })
    .join("");

  const body = `${navHeader("matrix", authed)}
<main>
<h1>渠道覆盖矩阵</h1>
<p class="lead">项目 × 渠道。数字气泡 = 未覆盖且适配的建议（值为标签适配分）。</p>
<div class="legend"><span class="posted">✓ 已发</span><span class="planned">◷ 计划中</span><span><span class="sug">3</span> 建议（适配分）</span><span class="na">— 不适配</span></div>
<div class="scroll"><table class="matrix-table"><thead><tr><th></th>${headCells}</tr></thead><tbody>${rows}</tbody></table></div>
<p class="hint">建议分 = 项目标签与渠道标签交集数；已覆盖／不适配的组合不再出现在总览的建议行动里。</p>
</main>`;
  return page("beacon · 渠道矩阵", body);
}

// A posted cell's attached effect (design doc §5 / review item 2): buildMatrix
// already pays ~10 extra D1 queries to compute coverage[].effect, but nothing
// consumed it — this cell rendered a bare ✓ regardless. Reuses .win-note (the
// impact page's own class, src/ui/layout.ts) for the exact same honesty rule:
// `effect.status === "collecting"` is the only state whose numbers (the
// after-window's own totals) are still incomplete — "insufficient-history"
// only ever describes a short *before* window, which this effect doesn't
// carry, so it needs no caveat here.
function effectSummary(effect: MatrixEffect | undefined): string {
  if (!effect) return "";
  const note = effect.status === "collecting" ? `<span class="win-note"> 统计中 ${effect.days}/7 天</span>` : "";
  return `<div class="cell-effect">浏览 ${effect.views} · star ${deltaArrow(effect.starsDelta)}${note}</div>`;
}

// Read-only cell — exactly today's markup, used for anonymous visitors.
function matrixStaticCell(cov: MatrixCoverageRow | undefined, score: number | undefined): string {
  if (cov?.status === "posted") return `<td class="posted" title="已发布">✓${effectSummary(cov.effect)}</td>`;
  if (cov?.status === "planned") return `<td class="planned" title="计划中">◷</td>`;
  if (cov?.status === "na") return `<td class="na">—</td>`;
  return score ? `<td><span class="sug">${score}</span></td>` : `<td class="na">—</td>`;
}

const CHANNEL_STATUS_OPTIONS: { value: "posted" | "planned" | "na"; label: string }[] = [
  { value: "posted", label: "✓ 已发" },
  { value: "planned", label: "◷ 计划中" },
  { value: "na", label: "— 不适配" }
];

// The <select>'s <option>s for one cell. When there's no coverage row yet, a
// disabled placeholder option is prepended (carrying the suggestion score, if
// any) so submitting without an explicit choice fails validation instead of
// silently writing a status the owner never picked — src/api/ui.ts's
// handleUiChannel rejects an empty `status` with 400.
function matrixCellOptions(status: string | undefined, score: number | undefined): string {
  const placeholder = status ? "" : `<option value="" selected disabled>${score ? `建议 ${score}` : "—"}</option>`;
  const real = CHANNEL_STATUS_OPTIONS.map(
    o => `<option value="${o.value}"${status === o.value ? " selected" : ""}>${o.label}</option>`
  ).join("");
  return placeholder + real;
}

// Authenticated cell: a small form (project/channelId/returnTo hidden, a status
// <select>, and a tiny submit button) posting to /ui/channel. `project`/`c.id`/
// `c.name` are all developer-configured (src/config.ts, src/channels.ts), not
// user input, but esc() is applied uniformly per the project's XSS discipline.
function matrixFormCell(
  projectName: string,
  c: { id: string; name: string },
  cov: MatrixCoverageRow | undefined,
  score: number | undefined
): string {
  return (
    `<td><form method="post" action="/ui/channel" class="blend">` +
    `<input type="hidden" name="project" value="${esc(projectName)}">` +
    `<input type="hidden" name="channelId" value="${esc(c.id)}">` +
    `<input type="hidden" name="returnTo" value="/matrix">` +
    `<select name="status" class="cell-select" aria-label="${esc(projectName)} × ${esc(c.name)}">${matrixCellOptions(cov?.status, score)}</select>` +
    `<button type="submit" class="cell-go" aria-label="保存">✓</button>` +
    `</form>${effectSummary(cov?.effect)}</td>`
  );
}

// ---- todos -------------------------------------------------------------------

function renderOpenTodoItem(t: Todo, authed: boolean): string {
  const checkbox = authed
    ? `<input type="checkbox" name="done" value="1" aria-label="标记为已完成">`
    : `<input type="checkbox" disabled>`;
  const rowInner =
    `${checkbox}<span class="pri p${t.priority}">P${t.priority}</span>` +
    `<span class="proj">${esc(t.project)}</span>${esc(t.title)}<span class="src">${esc(sourceLabel(t.source))}</span>`;
  if (!authed) return `<li>${rowInner}</li>`;
  return (
    `<li><form method="post" action="/ui/todo" class="blend">` +
    `<input type="hidden" name="id" value="${esc(String(t.id))}">` +
    `<input type="hidden" name="returnTo" value="/todos">` +
    `${rowInner}<button type="submit" class="go">保存</button></form></li>`
  );
}

function renderDoneTodoItem(t: Todo, authed: boolean, returnTo: string): string {
  const checkbox = authed
    ? `<input type="checkbox" name="done" value="1" checked aria-label="标记为进行中">`
    : `<input type="checkbox" checked disabled>`;
  const rowInner =
    `${checkbox}<span class="pri p${t.priority}">P${t.priority}</span>` +
    `<span class="proj">${esc(t.project)}</span><span class="title">${esc(t.title)}</span>` +
    `<span class="effect">${t.doneAt ? esc(fmtDateTime(t.doneAt)) : "—"}</span>`;
  if (!authed) return `<li class="done">${rowInner}</li>`;
  return (
    `<li class="done"><form method="post" action="/ui/todo" class="blend">` +
    `<input type="hidden" name="id" value="${esc(String(t.id))}">` +
    `<input type="hidden" name="returnTo" value="${esc(returnTo)}">` +
    `${rowInner}<button type="submit" class="go">保存</button></form></li>`
  );
}

// Open todos are sorted priority-ascending (P1 first) — this is the
// "priority-grouped" ordering; each item still carries its own P1/P2/P3 chip
// rather than being split under separate headings, matching
// design/pages/todos.html (a single flat list, sorted, no per-tier divider).
//
// `filter`: undefined (the default, reached via plain `/todos`) shows both
// sections, unchanged from before this feature. `"done"` (reached via
// `/todos?status=done`, src/index.ts) hides the open section — this is what
// makes the previously-decorative filter pills into working links; there's no
// symmetric `?status=open` because the default view already leads with open
// items, so "进行中" just links back to plain `/todos`.
export function renderTodos(todos: Todo[], authed: boolean, filter?: "done"): string {
  const open = todos.filter(t => t.status === "open").sort((a, b) => a.priority - b.priority);
  const done = todos.filter(t => t.status === "done");
  const showOpen = filter !== "done";
  const returnTo = filter === "done" ? "/todos?status=done" : "/todos";

  const filterLink = (label: string, count: number, key?: "done") => {
    const active = key === filter || (!key && !filter);
    const href = key ? `/todos?status=${key}` : "/todos";
    return `<a class="filter${active ? " on" : ""}" href="${href}">${esc(label)} ${count}</a>`;
  };

  const body = `${navHeader("todos", authed)}
<main>
<h1>待办</h1>
<p class="lead">体检 fail 项与矩阵建议自动生成；完成后与流量曲线叠加，看行动带来的变化。</p>
<div class="filters">${filterLink("进行中", open.length)}${filterLink("已完成", done.length, "done")}</div>
${showOpen
    ? `<p class="sec-cap">进行中</p>
<section><ul class="plain">${open.map(t => renderOpenTodoItem(t, authed)).join("") || `<li>暂无进行中待办</li>`}</ul></section>`
    : ""}
<p class="sec-cap">已完成</p>
<section><ul class="plain">${done.map(t => renderDoneTodoItem(t, authed, returnTo)).join("") || `<li>暂无已完成待办</li>`}</ul></section>
</main>`;
  return page("beacon · 待办", body);
}

// ---- posts -------------------------------------------------------------------

// <details>/<summary> gives the "＋ 登记帖子" affordance from
// design/pages/posts.html a native, JS-free collapsible panel — clicking the
// summary toggles the form via the browser's built-in disclosure behavior, no
// scripting involved. Reuses .card for visual consistency with the rest of
// the dashboard's boxed sections.
function addPostForm(): string {
  const projectOptions = CONFIG.projects.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
  return `<details class="card add-post">
<summary>＋ 登记帖子</summary>
<form method="post" action="/ui/post" class="card-form">
<input type="hidden" name="returnTo" value="/posts">
<label for="post-url">URL</label>
<input id="post-url" type="url" name="url" required placeholder="https://www.v2ex.com/t/...">
<label for="post-project">项目</label>
<select id="post-project" name="project" required>${projectOptions}</select>
<label for="post-title">标题（可选）</label>
<input id="post-title" type="text" name="title">
<label for="post-publishedAt">发布时间（可选，ISO，如 2026-08-01T09:00:00Z）</label>
<input id="post-publishedAt" type="text" name="publishedAt" placeholder="2026-08-01T09:00:00Z">
<button type="submit" class="primary">登记</button>
</form>
</details>`;
}

export function renderPosts(rows: PostWithMetrics[], authed: boolean): string {
  const body = `${navHeader("posts", authed)}
<main>
<h1>帖子榜单</h1>
<p class="lead"><span class="live"><span class="dot"></span>历史快照每日落库</span></p>
${authed ? addPostForm() : ""}
${postsTable(rows, { showProject: true, showDate: true })}
</main>`;
  return page("beacon · 帖子", body);
}

// ---- login -------------------------------------------------------------------

// GET/POST /login (src/api/session.ts). A single password field — no JS, no
// fetch: correct token -> 303 + Set-Cookie (session.ts); wrong token ->
// session.ts re-renders this exact page with error=true at HTTP 401.
export function renderLogin(error: boolean): string {
  const body = `<header><span class="logo">beacon</span></header>
<main>
<h1>登录</h1>
<p class="lead">输入管理员令牌以启用编辑功能。</p>
${error ? `<p class="error-text">令牌错误，请重试。</p>` : ""}
<form method="post" action="/login" class="card card-form">
<label for="admin-token">管理员令牌</label>
<input id="admin-token" type="password" name="token" autofocus required>
<button type="submit" class="primary">登录</button>
</form>
</main>`;
  return page("beacon · 登录", body);
}

// ---- impact ----------------------------------------------------------------

const EVENT_KIND_LABELS: Record<string, string> = { post: "发帖", todo: "待办" };

// A window's numbers are only ever a *conclusion* when its 7 days are all
// reported. GitHub's traffic feed ends at "yesterday" and beacon's 01:00 UTC
// cron usually sees one day less than that, so a freshly-published post has an
// after-window that is genuinely incomplete — and showing its partial sum as a
// bare number reads as "this did nothing", which is the single most damaging
// thing this page could say. Hence the caveat travels inside the row, next to
// the very numbers it qualifies, rather than living in a page-level footnote.
//
// `note` is caller-supplied text (rather than a boolean) because the two
// windows need different wording for the same underlying fact (review items
// 4/5): an incomplete *after* window is temporary ("统计中" — more days will
// land), but a short *before* window is permanent — that history predates
// collection and will never grow — so reusing "统计中" there would promise
// data that's never coming. Empty string renders no caveat at all.
function windowCell(label: string, w: ImpactWindow, note: string): string {
  const noteHtml = note ? `<span class="win-note">${esc(note)}</span>` : "";
  return (
    `<div class="win"><div class="win-h">${esc(label)}${noteHtml}</div>` +
    // "人类" (review item 6): this figure is classifyDay-filtered (human-only),
    // unlike the raw/unfiltered clone curve on the project detail page — the
    // label is what stops a reader from conflating the two measures.
    `<div class="win-n"><span>浏览 ${w.views}</span><span>人类 clone ${w.humanClones}</span>` +
    `<span>star ${deltaArrow(w.starsDelta)}</span></div></div>`
  );
}

function impactRow(i: EventImpact): string {
  const e = i.event;
  const kind = EVENT_KIND_LABELS[e.kind] ?? e.kind;
  // Only a "complete" row earns the confident styling; the other two states
  // stay visually distinct so a glance can't mistake a provisional number for
  // a settled one.
  const cls = i.status === "complete" ? "ok" : i.status === "collecting" ? "pending" : "partial";
  const title = e.url
    ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>`
    : esc(e.title);
  const platform = e.platform ? `<span class="platform">${esc(PLATFORM_LABELS[e.platform] ?? e.platform)}</span>` : "";
  // Review item 4: gated on each window's own day count, not on the row's
  // overall `status` — `status` resolves to "collecting" whenever the *after*
  // window is short (design doc §4's "after wins" priority), which used to
  // leave a short *before* window with no caveat at all whenever both windows
  // were short, silently rendering a partial sum as a settled number.
  //
  // Review item 5: the before-window's own wording ("历史仅 N 天") states the
  // day count without implying more will arrive — unlike the after-window's
  // "统计中", that history predates collection and never grows.
  const beforeNote = i.before.days < 7 ? `历史仅 ${i.before.days} 天` : "";
  const afterNote = i.status === "collecting" ? `统计中 · 已有 ${i.after.days}/7 天` : "";
  return (
    `<li><div class="ev-head"><span class="ev-date">${esc(e.date)}</span>` +
    `<span class="src">${esc(kind)}</span>${platform}` +
    `<a class="proj" href="/p/${encodeURIComponent(e.project)}">${esc(e.project)}</a>` +
    `<span class="ev-title ${cls}">${title}</span></div>` +
    `<div class="ev-wins">${windowCell("之前 7 天", i.before, beforeNote)}` +
    `<span class="ev-arrow">→</span>` +
    `${windowCell("之后 7 天", i.after, afterNote)}</div></li>`
  );
}

export function renderImpact(impacts: EventImpact[], authed: boolean): string {
  const rows = impacts.map(impactRow).join("");
  const body = `${navHeader("impact", authed)}
<main>
<h1>效果归因</h1>
<p class="lead">每一次发帖、每一条做完的待办，对照它前后 7 天的真实数字。窗口未采满的行会标注「统计中」——那不是结论，别当成没效果。</p>
${rows ? `<ol class="impact">${rows}</ol>` : `<p class="sub">暂无事件。登记一篇帖子或做完一条待办，这里就会出现它的效果。</p>`}
</main>`;
  return page("beacon · 效果归因", body);
}
