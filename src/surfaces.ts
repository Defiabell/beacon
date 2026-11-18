// Discovery surfaces: what *kind* of place sent someone to a repo.
//
// This is a different axis from src/channels.ts. A channel is somewhere you
// deliberately post; a surface is any place traffic can arrive from, including
// ones you never act on (a search engine, an AI answer engine, an RSS reader,
// a site that scraped you). Passive observation, so it can answer questions no
// channel list can — "are AI answer engines sending anyone yet?" being the one
// this was built for.
//
// Deliberately NOT folded into CHANNELS: a channel carries a fit score and
// shows up as a suggestion to go post there, and "go post on Google" is not an
// action. Keeping them separate also means a surface needs no editorial upkeep.

export type SurfaceId = "ai" | "search" | "curation" | "community" | "rss" | "code-host" | "own";

export interface Surface {
  id: SurfaceId;
  name: string;
  // Why this bucket is worth watching separately, shown on the page — a bucket
  // with no stated purpose becomes a number nobody knows how to read.
  note: string;
  hosts: string[];
}

// GitHub does not report every referrer as a hostname: search engines arrive as
// display labels ("Google", "Bing", "DuckDuckGo"), which is why these lists mix
// the two forms and why classifyReferrer compares case-insensitively.
export const SURFACES: Surface[] = [
  {
    id: "ai",
    name: "AI 答案引擎",
    note: "被 AI 助手引用后带来的访问。这是 GEO 唯一能被量到的出口——为它做的任何优化，效果都只会在这一格里出现。",
    hosts: [
      "chatgpt.com",
      "chat.openai.com",
      "openai.com",
      "perplexity.ai",
      "claude.ai",
      "gemini.google.com",
      "copilot.microsoft.com",
      "grok.com",
      "duck.ai",
      "meta.ai",
      "chat.deepseek.com",
      "chat.mistral.ai",
      "phind.com",
      "you.com",
      "felo.ai",
      "genspark.ai",
      "metaso.cn",
      "kimi.com",
      "moonshot.cn",
      "doubao.com",
      "yuanbao.tencent.com",
      "tongyi.com",
      // Path labels (see referrerLabel below): AI products that live under a
      // path of a general-purpose site. The bare host stays on "search".
      "bing.com/copilotsearch",
      "x.com/i/grok",
      "kagi.com/assistant"
    ]
  },
  {
    id: "search",
    name: "搜索引擎",
    note: "传统自然搜索。和上面一格一起看，才知道发现方式正在往哪边挪。",
    hosts: ["Google", "google.com", "Bing", "bing.com", "DuckDuckGo", "duckduckgo.com", "kagi.com", "baidu.com", "sogou.com", "yandex.com", "ecosia.org"]
  },
  {
    id: "curation",
    name: "策展/周刊",
    note: "有人替你背书之后带来的访问。目前唯一被验证有效的增长杠杆。",
    hosts: ["ruanyifeng.com", "hellogithub.com", "weekly.tw93.fun", "tw93.fun", "selfh.st", "console.dev", "appinn.com"]
  },
  {
    id: "community",
    name: "社区",
    note: "自己发帖的地方。没有编辑推流，曝光靠帖子自身在社区里被顶起来。",
    hosts: [
      "v2ex.com",
      // V2EX's own alternate domain (global.v2ex.co) — the same site.
      "v2ex.co",
      "linux.do",
      "meta.appinn.net",
      "reddit.com",
      "news.ycombinator.com",
      "juejin.cn",
      "zhihu.com",
      "sspai.com",
      "eleduck.com",
      "producthunt.com",
      "indienova.com",
      "gcores.com"
    ]
  },
  {
    id: "rss",
    name: "RSS/阅读器",
    note: "订阅型触达。它的存在说明有人把你加进了长期关注列表，比一次性点击更有价值。",
    hosts: ["inoreader.com", "feedly.com", "newsblur.com", "theoldreader.com", "rss.app", "follow.is"]
  },
  {
    id: "code-host",
    name: "代码托管站内",
    note: "GitHub 自己的 trending、搜索、推荐带来的访问。它是被别处推火之后的二阶效果，不是独立渠道。",
    hosts: ["github.com", "gitee.com", "gitlab.com"]
  },
  {
    id: "own",
    name: "自有站点",
    note: "自己的页面之间互相跳转，包括这个面板本身。不算外部曝光，单列出来是为了不让它混进其他格子。",
    hosts: ["defiabell.com", "defiabell.github.io", "defiabell.pages.dev", "shiling.pages.dev", "workers.dev"]
  }
];

// AI products that share a host with an ordinary search engine and are only
// told apart by the referrer's path. referrerLabel folds a matching (host,
// path) into one of these labels so that classifyReferrer (which only ever
// sees a string) can place it on the "ai" surface while the bare host stays
// on "search". Prefix match on the path, exact-or-subdomain match on the host.
//
// What this deliberately cannot cover — a query string is never part of a
// referrer, and Cloudflare RUM has no dimension for it:
//   - Google AI Mode (`google.com/search?udm=50`): the only marker is the
//     `udm=50` query parameter, and google.com also sends an origin-only
//     referrer, so these arrivals are indistinguishable from plain search.
//   - DuckDuckGo AI chat on the main host (`duckduckgo.com/?ia=chat`): same
//     shape; only the dedicated duck.ai host is recognisable.
// Both stay counted under "search". Measured 2026-11-01: RUM does deliver
// refererPath for hosts that send one (www.v2ex.com /t/1252234, github.com
// /ruanyf/weekly/issues/12817), so the path rules below are not theoretical.
const AI_PATH_LABELS: { host: string; prefix: string; label: string }[] = [
  { host: "bing.com", prefix: "/copilotsearch", label: "bing.com/copilotsearch" },
  { host: "x.com", prefix: "/i/grok", label: "x.com/i/grok" },
  { host: "kagi.com", prefix: "/assistant", label: "kagi.com/assistant" }
];

// The string a site-level referrer is stored and classified as: the lower-cased
// host, or one of the AI_PATH_LABELS when the path says the arrival came from
// that host's AI product rather than its search box. Everything that isn't a
// path-rule host ignores the path entirely, so cardinality stays at one row
// per referring host per day.
export function referrerLabel(host: string, path: string | null | undefined): string {
  const h = host.toLowerCase();
  const p = (path ?? "").toLowerCase();
  for (const rule of AI_PATH_LABELS) {
    if (matches(h, rule.host) && p.startsWith(rule.prefix)) return rule.label;
  }
  return h;
}

// Exact match or subdomain suffix, case-insensitive. `workers.dev` on the "own"
// surface intentionally matches every *.workers.dev subdomain — beacon itself,
// the shotsync demo, and the screen-coach trial all live there and are all our
// own pages.
function matches(referrer: string, host: string): boolean {
  const r = referrer.toLowerCase();
  const h = host.toLowerCase();
  return r === h || r.endsWith("." + h);
}

// Returns null for anything no surface claims. That case is NOT swept into an
// "other" constant here on purpose: callers must render unclassified referrers
// by name, because an unrecognized host is the most interesting row on the page
// — it is either a new surface worth adding or someone scraping you, and both
// only get noticed if the host is shown rather than counted.
//
// Real example this was written for: shotsync started receiving traffic from
// seju.life / 1fuli.one / ixue.me / lewuxian.com right as 阮一峰周刊 published.
// They look like a ring of Chinese resource-farm sites (several share one site
// template, some are adult-content farms), and whether they actually republish
// the weekly was never confirmed. Bucketing them as "aggregator" on the
// strength of the timing would have turned a guess into a number.
export function classifyReferrer(referrer: string): SurfaceId | null {
  for (const s of SURFACES) {
    if (s.hosts.some(h => matches(referrer, h))) return s.id;
  }
  return null;
}
