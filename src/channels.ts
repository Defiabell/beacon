import type { ProjectConfig } from "./config";

// How you actually get onto a channel. The suggestion score answers "is this
// channel topically a fit"; it says nothing about what the action even *is* —
// and these four are wildly different pieces of work (open a thread / open a PR
// against someone's awesome-list / pitch an editor / register a product page).
// Surfacing the kind next to the score is what turns "screen-coach × 少数派,
// 4 分" from a number into something the owner can act on without having to ask
// what it means.
export type ChannelKind = "post" | "list-pr" | "pitch" | "listing";

export interface Channel {
  id: string;
  name: string;
  url: string;
  lang: "zh" | "en";
  tags: string[];
  kind: ChannelKind;
  // One imperative sentence or two: what to open, what to prepare, and the one
  // gotcha that would waste the attempt. Editorial knowledge about the channel
  // itself (not per-project state), so it lives in code next to the channel
  // rather than in D1.
  howTo: string;
}

export const CHANNELS: Channel[] = [
  {
    id: "v2ex",
    name: "V2EX 分享创造",
    url: "https://www.v2ex.com/go/create",
    lang: "zh",
    tags: ["tool", "web", "game", "macos", "ai", "selfhosted", "zh"],
    kind: "post",
    howTo:
      "在「分享创造」节点发帖：一句话定位 + 一张能一眼看懂的截图 + 仓库链接，标题别带营销口气。发完当天守着回帖，V2EX 的曝光靠回复顶上去。"
  },
  {
    id: "linuxdo",
    name: "LinuxDO",
    url: "https://linux.do",
    lang: "zh",
    tags: ["tool", "web", "game", "macos", "ai", "selfhosted", "zh"],
    kind: "post",
    howTo:
      "发帖时按内容选一个技术或资源类分类。社区吃技术细节——讲清怎么实现的比讲有什么功能更受欢迎。注意 beacon 抓不到 LinuxDO 的帖子数字（出口 IP 被挡），效果只能从 GitHub 流量侧面看。"
  },
  {
    id: "sspai",
    name: "少数派 Matrix",
    url: "https://sspai.com",
    lang: "zh",
    tags: ["macos", "tool", "ai", "zh"],
    kind: "pitch",
    howTo:
      "Matrix 是投稿制：注册后写一篇完整的使用体验文投给编辑，过审才会推首页。适合 macOS 效率工具，周期以周计，不是当天见效的渠道。"
  },
  {
    id: "appinn",
    name: "小众软件",
    url: "https://www.appinn.com",
    lang: "zh",
    tags: ["macos", "tool", "selfhosted", "zh"],
    kind: "pitch",
    howTo: "走站内投稿入口自荐，给一句话介绍、截图和下载地址，由编辑筛选后成文。工具类命中率高于内容类。"
  },
  {
    id: "jike",
    name: "即刻",
    url: "https://web.okjike.com",
    lang: "zh",
    tags: ["tool", "ai", "game", "zh"],
    kind: "post",
    howTo: "个人动态发短图文，配一张截图，带上相关圈子扩散。适合发过程和小更新，长文没人看。"
  },
  {
    id: "eleduck",
    name: "电鸭社区",
    url: "https://eleduck.com",
    lang: "zh",
    tags: ["tool", "web", "zh"],
    kind: "post",
    howTo: "受众是远程和独立开发者，吃「我为什么做这个、做了多久、赚不赚钱」的过程叙事；纯功能介绍反响一般。"
  },
  {
    id: "juejin",
    name: "掘金",
    url: "https://juejin.cn",
    lang: "zh",
    tags: ["web", "ai", "tool", "zh"],
    kind: "post",
    howTo: "写一篇技术实现文（架构选择、踩过的坑），文末再带仓库。掘金吃「怎么做的」，不吃「我做了个」。"
  },
  {
    id: "indienova",
    name: "indienova",
    url: "https://indienova.com",
    lang: "zh",
    tags: ["game", "zh"],
    kind: "post",
    howTo: "建游戏页面并发开发日志。中文独立游戏受众最集中的地方，适合连载式更新而非一次性公告。"
  },
  {
    id: "gcores",
    name: "机核",
    url: "https://www.gcores.com",
    lang: "zh",
    tags: ["game", "zh"],
    kind: "post",
    howTo: "偏游戏文化内容，适合写设计思路和灵感来源而不是发布公告。门槛高，但读者精准。"
  },
  {
    id: "itchio",
    name: "itch.io",
    url: "https://itch.io",
    lang: "en",
    tags: ["game", "web", "en"],
    kind: "listing",
    howTo:
      "免费建一个游戏页面，上传 web 构建或填外链，必须配封面图和一段 GIF。itch.io 自带搜索和分类流量，属于长尾——挂上去就一直在。"
  },
  {
    id: "show-hn",
    name: "Show HN",
    url: "https://news.ycombinator.com/showhn.html",
    lang: "en",
    tags: ["tool", "selfhosted", "web", "ai", "game", "en"],
    kind: "post",
    howTo:
      "标题格式固定：`Show HN: 项目名 – 一句话说明`。发布后立刻自己回一条评论讲背景和技术选择。一个项目基本只有一次机会，选美西工作日早上发，别顺手用掉。"
  },
  {
    id: "producthunt",
    name: "Product Hunt",
    url: "https://www.producthunt.com",
    lang: "en",
    tags: ["tool", "macos", "ai", "en"],
    kind: "post",
    howTo:
      "要提前备好 logo、画廊图、tagline，并选定一个发布日。PH 主要奖励已经有英文受众积累的产品，零关注冷启动效果有限——别把它当第一站。"
  },
  {
    id: "r-selfhosted",
    name: "r/selfhosted",
    url: "https://www.reddit.com/r/selfhosted/",
    lang: "en",
    tags: ["selfhosted", "en"],
    kind: "post",
    howTo:
      "先读 sub 规则（多数禁纯推广）。用「我自建了 X 来解决 Y」的第一人称写法，明确标注自己是作者，不要只贴链接。beacon 抓不到 Reddit 数字。"
  },
  {
    id: "r-macapps",
    name: "r/macapps",
    url: "https://www.reddit.com/r/macapps/",
    lang: "en",
    tags: ["macos", "en"],
    kind: "post",
    howTo: "带截图，并在正文明确写清免费/付费和是否开源。社区对作者自荐宽容，但要求标明身份。beacon 抓不到 Reddit 数字。"
  },
  {
    id: "r-sideproject",
    name: "r/SideProject",
    url: "https://www.reddit.com/r/SideProject/",
    lang: "en",
    tags: ["tool", "web", "game", "ai", "en"],
    kind: "post",
    howTo: "允许自荐，适合发「我做了什么、目前数据如何」。一张截图加一句话就够，长篇反而没人读。beacon 抓不到 Reddit 数字。"
  },
  {
    id: "r-webgames",
    name: "r/WebGames",
    url: "https://www.reddit.com/r/WebGames/",
    lang: "en",
    tags: ["game", "web", "en"],
    kind: "post",
    howTo: "直接贴可玩链接。前提是点开即玩——要注册、要下载、加载慢的一律沉底。beacon 抓不到 Reddit 数字。"
  },
  {
    id: "awesome-selfhosted",
    name: "awesome-selfhosted",
    url: "https://github.com/awesome-selfhosted/awesome-selfhosted",
    lang: "en",
    tags: ["selfhosted", "en"],
    kind: "list-pr",
    howTo:
      "fork 仓库，按 README 里既有条目的格式加一行（名称、一句话、demo、License、语言），提 PR。收录门槛包括已有 LICENSE 和像样的文档，先过体检再来。"
  },
  {
    id: "ruanyf-weekly",
    name: "阮一峰科技爱好者周刊（issue 自荐）",
    url: "https://github.com/ruanyf/weekly",
    lang: "zh",
    tags: ["tool", "web", "macos", "ai", "selfhosted", "zh"],
    kind: "pitch",
    howTo:
      "去 ruanyf/weekly 仓库找当期的投稿 issue，按格式回复一条自荐（一句话 + 链接）。每周五出刊，命中率不高，但一次只花十分钟，值得反复投。"
  },
  {
    id: "hellogithub",
    name: "HelloGitHub 月刊（自荐）",
    url: "https://github.com/521xueweihan/HelloGitHub",
    lang: "zh",
    tags: ["tool", "web", "ai", "selfhosted", "zh"],
    kind: "pitch",
    howTo: "在官网或仓库的推荐入口提交项目。要求 README 完整、有截图、能跑起来。一旦被月刊收录会带来一波稳定的中文流量。"
  },
  {
    id: "zhihu",
    name: "知乎",
    url: "https://www.zhihu.com",
    lang: "zh",
    tags: ["tool", "ai", "game", "zh"],
    kind: "post",
    howTo: "写回答通常比写文章有效：搜「有哪些好用的 X」这类现成问题，在答案里自然带出项目。回答会被搜索和推荐反复带出来，专栏文章主要触达已关注的人。"
  },
  {
    id: "xiaohongshu",
    name: "小红书",
    url: "https://www.xiaohongshu.com",
    lang: "zh",
    tags: ["tool", "ai", "zh"],
    kind: "post",
    howTo: "图片优先：做 3—5 张竖版图讲清「解决什么问题」，第一张图就是标题。正文短、带话题标签。站内不方便放外链，靠评论区或简介引导。"
  },
  {
    id: "wechat-mp",
    name: "微信公众号",
    url: "https://mp.weixin.qq.com",
    lang: "zh",
    tags: ["tool", "ai", "zh"],
    kind: "post",
    howTo: "适合放长文复盘，沉淀给已关注的人看。公众号几乎没有站内分发，不要指望它拉新——它是留存渠道，不是曝光渠道。"
  },
  {
    id: "bilibili",
    name: "B 站（演示视频）",
    url: "https://www.bilibili.com",
    lang: "zh",
    tags: ["tool", "game", "ai", "zh"],
    kind: "post",
    howTo: "录一段 60 秒以内的演示，标题直接写结果。交互类工具和游戏用视频说明远胜截图，代价是制作成本高一档。"
  },
  {
    id: "awesome-tauri",
    name: "awesome-tauri（PR 收录）",
    url: "https://github.com/tauri-apps/awesome-tauri",
    lang: "en",
    tags: ["macos", "tool", "en"],
    kind: "list-pr",
    howTo: "fork tauri-apps/awesome-tauri，在对应分类下按格式加一行，提 PR。需要仓库有截图和可下载的 Release 产物。"
  },
  {
    id: "awesome-mac",
    name: "awesome-mac（PR 收录）",
    url: "https://github.com/jaywcjlove/awesome-mac",
    lang: "en",
    tags: ["macos", "tool", "en"],
    kind: "list-pr",
    howTo: "fork jaywcjlove/awesome-mac，找到对应分类加条目，开源和免费要按 README 约定打上标记，然后提 PR。"
  },
  {
    id: "alternativeto",
    name: "AlternativeTo（登记产品）",
    url: "https://alternativeto.net",
    lang: "en",
    tags: ["tool", "web", "selfhosted", "macos", "en"],
    kind: "listing",
    howTo:
      "登记一个产品页，填 logo、截图和描述。最关键的字段是「它是谁的替代品」——这个平台整个产品形态就是围绕替代关系组织的，这一栏填不准，条目基本不会被翻到。"
  }
];

export function fitScore(project: ProjectConfig, channel: Channel): number {
  return channel.tags.filter(t => project.tags.includes(t)).length;
}

export interface Suggestion { project: string; channelId: string; channelName: string; score: number; }

export function suggestPairs(projects: ProjectConfig[], coverage: { project: string; channelId: string; status: string }[]): Suggestion[] {
  const covered = new Set(coverage.map(c => `${c.project}:${c.channelId}`));
  const out: Suggestion[] = [];
  for (const p of projects) for (const c of CHANNELS) {
    if (covered.has(`${p.name}:${c.id}`)) continue;
    const score = fitScore(p, c);
    if (score > 0) out.push({ project: p.name, channelId: c.id, channelName: c.name, score });
  }
  return out.sort((a, b) => b.score - a.score);
}
