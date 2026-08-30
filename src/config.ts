export interface ProjectConfig { name: string; repo: string; tags: string[]; homepage?: string; }
// A site tracked by Cloudflare Web Analytics. One entry == one hostname, which
// is how Web Analytics scopes a "site": defiabell.github.io therefore covers
// both the blog and the nightide game living at /nightide/ under it.
export interface SiteConfig { name: string; host: string; siteTag: string; }
export interface BeaconConfig {
  githubUser: string;
  projects: ProjectConfig[];
  sites: SiteConfig[];
  dashboardTitle: string;
}
export const CONFIG: BeaconConfig = {
  githubUser: "Defiabell",
  dashboardTitle: "Defiabell / beacon",
  projects: [
    { name: "nightide", repo: "Defiabell/nightide", tags: ["game", "web", "zh", "en"], homepage: "https://defiabell.github.io/nightide/" },
    { name: "day-monitor", repo: "Defiabell/day-monitor", tags: ["macos", "tool", "ai", "en"], homepage: "https://defiabell.github.io/day-monitor/" },
    { name: "shotsync", repo: "Defiabell/shotsync", tags: ["selfhosted", "tool", "web", "en"], homepage: "https://shotsync-demo.defiabell.workers.dev" },
    { name: "screen-coach", repo: "Defiabell/screen-coach", tags: ["macos", "tool", "ai", "zh"], homepage: "https://screen-coach-trial.defiabell.workers.dev" },
    { name: "shiling", repo: "Defiabell/shiling", tags: ["game", "web", "zh"], homepage: "https://shiling.pages.dev" }
  ],
  // siteTag (not site_token) — the internal id RUM's GraphQL filters on.
  sites: [
    { name: "听风闲语 + 夜潮", host: "defiabell.github.io", siteTag: "679daf9b94fa433aa14020d7a40caf1b" },
    { name: "英文站", host: "defiabell.pages.dev", siteTag: "642a79a267904b0dbc59a7d712a0d32e" },
    { name: "mythmesh", host: "mythmesh.pages.dev", siteTag: "79f96ab6a4fb4226affa009174c939ff" },
    { name: "食灵", host: "shiling.pages.dev", siteTag: "53be0dd64f2a46faa726fac13eb404a6" }
  ]
};
