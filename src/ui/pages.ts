// Five SSR page renderers, one per route in Task 12's router. Every function
// returns a complete HTML document (via layout.page) ready to hand back in a
// Response. All dynamic (DB-, GitHub-, or user-submitted-) text passes through
// esc() before being interpolated — see src/ui/layout.ts for that contract.
//
// Look & feel follows design/pages/{overview,project,matrix,todos,posts}.html
// verbatim (class names, layout). See task-12-report.md for the handful of
// deliberate deviations where the data available from src/api/public.ts
// doesn't (yet) carry what the mockup shows.
import type { Overview, ProjectDetail, MatrixData, PostWithMetrics, ProjectSummary } from "../api/public";
import type { Todo, SourceRun, ReferrerRow, CheckResult, Platform } from "../types";
import { CONFIG } from "../config";
import { page, svgSparkline, esc } from "./layout";

type NavKey = "overview" | "matrix" | "todos" | "posts" | null;

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

// Shared header/nav. Nav links + active-page highlighting are identical
// across overview/matrix/todos/posts; the project detail page uses a
// simpler "← 返回总览" nav instead (matches design/pages/project.html), so it
// builds its own header rather than calling this.
function navHeader(active: NavKey): string {
  const link = (href: string, label: string, key: NavKey) =>
    `<a${key === active ? ' class="active"' : ""} href="${href}">${label}</a>`;
  return (
    `<header><span class="logo">beacon</span><nav>` +
    `${link("/", "总览", "overview")}${link("/matrix", "渠道矩阵", "matrix")}` +
    `${link("/todos", "待办", "todos")}${link("/posts", "帖子", "posts")}` +
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
  return `<div class="card">
<h3><a href="/p/${encodeURIComponent(p.project)}">${esc(p.project)}</a></h3>
<p class="repo">${esc(p.repo)}${tags ? " · " + esc(tags) : ""}</p>
<div class="stat-row"><span class="big">${p.stars}</span><span class="unit">stars</span><span class="delta">${deltaArrow(p.starsDelta7d)} 本周</span></div>
<div class="foot"><span class="chip">views 14d ${p.views14d}</span><span class="chip">clones 14d ${p.clones14d}</span><span class="chip">帖子 ${p.postCount}</span>${referrerChip}</div>
</div>`;
}

export function renderOverview(o: Overview): string {
  const actions = actionItems(o).map(renderActionItem).join("") || `<li>暂无待办建议</li>`;
  const cards = o.projects.map(projectCard).join("") || `<p class="sub">暂无项目</p>`;
  const body = `${navHeader("overview")}
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
  return `<li class="${cls}">${esc(label)}<span class="chip">${esc(a.detail)}</span></li>`;
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

export function renderProject(name: string, d: ProjectDetail): string {
  const s = d.summary;
  const failCount = d.audit.filter(a => a.status === "fail").length;
  const starSpark = svgSparkline(d.starSeries.map(r => r.stars), 640, 90);
  const viewsSpark = svgSparkline(d.repoSeries.map(r => r.views), 300, 48);
  const clonesSpark = svgSparkline(d.repoSeries.map(r => r.clones), 300, 48);
  const header = `<header><span class="logo">beacon</span><nav><a href="/">← 返回总览</a></nav></header>`;

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
<div><div class="hero"><div><div class="n">${s.clones14d}</div><div class="l">clones · 14d</div></div></div>${clonesSpark}</div>
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

export function renderMatrix(m: MatrixData): string {
  const covByKey = new Map(m.coverage.map(c => [`${c.project}:${c.channelId}`, c.status]));
  const sugByKey = new Map(m.suggestions.map(s => [`${s.project}:${s.channelId}`, s.score]));

  const headCells = m.channels
    .map(c => `<th>${esc(c.name)}<span class="lang">${esc(LANG_LABELS[c.lang] ?? c.lang)}</span></th>`)
    .join("");

  const rows = m.projects
    .map(projectName => {
      const cells = m.channels
        .map(c => {
          const status = covByKey.get(`${projectName}:${c.id}`);
          if (status === "posted") return `<td class="posted" title="已发布">✓</td>`;
          if (status === "planned") return `<td class="planned" title="计划中">◷</td>`;
          if (status === "na") return `<td class="na">—</td>`;
          const score = sugByKey.get(`${projectName}:${c.id}`);
          return score ? `<td><span class="sug">${score}</span></td>` : `<td class="na">—</td>`;
        })
        .join("");
      return `<tr><th>${esc(projectName)}</th>${cells}</tr>`;
    })
    .join("");

  const body = `${navHeader("matrix")}
<main>
<h1>渠道覆盖矩阵</h1>
<p class="lead">项目 × 渠道。数字气泡 = 未覆盖且适配的建议（值为标签适配分）。</p>
<div class="legend"><span class="posted">✓ 已发</span><span class="planned">◷ 计划中</span><span><span class="sug">3</span> 建议（适配分）</span><span class="na">— 不适配</span></div>
<div class="scroll"><table class="matrix-table"><thead><tr><th></th>${headCells}</tr></thead><tbody>${rows}</tbody></table></div>
<p class="hint">建议分 = 项目标签与渠道标签交集数；已覆盖／不适配的组合不再出现在总览的建议行动里。</p>
</main>`;
  return page("beacon · 渠道矩阵", body);
}

// ---- todos -------------------------------------------------------------------

function renderOpenTodoItem(t: Todo): string {
  return (
    `<li><input type="checkbox" disabled><span class="pri p${t.priority}">P${t.priority}</span>` +
    `<span class="proj">${esc(t.project)}</span>${esc(t.title)}<span class="src">${esc(sourceLabel(t.source))}</span></li>`
  );
}

function renderDoneTodoItem(t: Todo): string {
  return (
    `<li class="done"><input type="checkbox" checked disabled><span class="pri p${t.priority}">P${t.priority}</span>` +
    `<span class="proj">${esc(t.project)}</span><span class="title">${esc(t.title)}</span>` +
    `<span class="effect">${t.doneAt ? esc(fmtDateTime(t.doneAt)) : "—"}</span></li>`
  );
}

// Open todos are sorted priority-ascending (P1 first) — this is the
// "priority-grouped" ordering; each item still carries its own P1/P2/P3 chip
// rather than being split under separate headings, matching
// design/pages/todos.html (a single flat list, sorted, no per-tier divider).
export function renderTodos(todos: Todo[]): string {
  const open = todos.filter(t => t.status === "open").sort((a, b) => a.priority - b.priority);
  const done = todos.filter(t => t.status === "done");

  const body = `${navHeader("todos")}
<main>
<h1>待办</h1>
<p class="lead">体检 fail 项与矩阵建议自动生成；完成后与流量曲线叠加，看行动带来的变化。</p>
<div class="filters"><button class="on">进行中 ${open.length}</button><button>已完成 ${done.length}</button></div>
<p class="sec-cap">进行中</p>
<section><ul class="plain">${open.map(renderOpenTodoItem).join("") || `<li>暂无进行中待办</li>`}</ul></section>
<p class="sec-cap">已完成</p>
<section><ul class="plain">${done.map(renderDoneTodoItem).join("") || `<li>暂无已完成待办</li>`}</ul></section>
</main>`;
  return page("beacon · 待办", body);
}

// ---- posts -------------------------------------------------------------------

export function renderPosts(rows: PostWithMetrics[]): string {
  const body = `${navHeader("posts")}
<main>
<h1>帖子榜单</h1>
<p class="lead"><span class="live"><span class="dot"></span>历史快照每日落库</span></p>
${postsTable(rows, { showProject: true, showDate: true })}
</main>`;
  return page("beacon · 帖子", body);
}
