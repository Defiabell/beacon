export interface ProjectConfig { name: string; repo: string; tags: string[]; homepage?: string; }
export interface BeaconConfig { githubUser: string; projects: ProjectConfig[]; dashboardTitle: string; }
export const CONFIG: BeaconConfig = {
  githubUser: "Defiabell",
  dashboardTitle: "Defiabell / beacon",
  projects: [
    { name: "nightide", repo: "Defiabell/nightide", tags: ["game", "web", "zh", "en"], homepage: "https://defiabell.github.io/nightide/" },
    { name: "day-monitor", repo: "Defiabell/day-monitor", tags: ["macos", "tool", "ai", "en"] },
    { name: "shotsync", repo: "Defiabell/shotsync", tags: ["selfhosted", "tool", "web", "en"] },
    { name: "screen-coach", repo: "Defiabell/screen-coach", tags: ["macos", "tool", "ai", "zh"] },
    { name: "shiling", repo: "Defiabell/shiling", tags: ["game", "web", "zh"], homepage: "https://shiling.pages.dev" }
  ]
};
