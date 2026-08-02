import type { ProjectConfig } from "./config";
export interface Channel { id: string; name: string; url: string; lang: "zh" | "en"; tags: string[]; }
export const CHANNELS: Channel[] = [
  { id: "v2ex", name: "V2EX 分享创造", url: "https://www.v2ex.com/go/create", lang: "zh", tags: ["tool", "web", "game", "macos", "ai", "selfhosted", "zh"] },
  { id: "linuxdo", name: "LinuxDO", url: "https://linux.do", lang: "zh", tags: ["tool", "web", "game", "macos", "ai", "selfhosted", "zh"] },
  { id: "sspai", name: "少数派 Matrix", url: "https://sspai.com", lang: "zh", tags: ["macos", "tool", "ai", "zh"] },
  { id: "appinn", name: "小众软件", url: "https://www.appinn.com", lang: "zh", tags: ["macos", "tool", "selfhosted", "zh"] },
  { id: "jike", name: "即刻", url: "https://web.okjike.com", lang: "zh", tags: ["tool", "ai", "game", "zh"] },
  { id: "eleduck", name: "电鸭社区", url: "https://eleduck.com", lang: "zh", tags: ["tool", "web", "zh"] },
  { id: "juejin", name: "掘金", url: "https://juejin.cn", lang: "zh", tags: ["web", "ai", "tool", "zh"] },
  { id: "indienova", name: "indienova", url: "https://indienova.com", lang: "zh", tags: ["game", "zh"] },
  { id: "gcores", name: "机核", url: "https://www.gcores.com", lang: "zh", tags: ["game", "zh"] },
  { id: "itchio", name: "itch.io", url: "https://itch.io", lang: "en", tags: ["game", "web", "en"] },
  { id: "show-hn", name: "Show HN", url: "https://news.ycombinator.com/showhn.html", lang: "en", tags: ["tool", "selfhosted", "web", "ai", "game", "en"] },
  { id: "producthunt", name: "Product Hunt", url: "https://www.producthunt.com", lang: "en", tags: ["tool", "macos", "ai", "en"] },
  { id: "r-selfhosted", name: "r/selfhosted", url: "https://www.reddit.com/r/selfhosted/", lang: "en", tags: ["selfhosted", "en"] },
  { id: "r-macapps", name: "r/macapps", url: "https://www.reddit.com/r/macapps/", lang: "en", tags: ["macos", "en"] },
  { id: "r-sideproject", name: "r/SideProject", url: "https://www.reddit.com/r/SideProject/", lang: "en", tags: ["tool", "web", "game", "ai", "en"] },
  { id: "r-webgames", name: "r/WebGames", url: "https://www.reddit.com/r/WebGames/", lang: "en", tags: ["game", "web", "en"] },
  { id: "awesome-selfhosted", name: "awesome-selfhosted", url: "https://github.com/awesome-selfhosted/awesome-selfhosted", lang: "en", tags: ["selfhosted", "en"] }
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
