export interface ProjectConfig {
  name: string;
  repo: string;
  tags: string[];
  homepage?: string;
  // "all-rights-reserved" exempts the repo from the LICENSE check. That check
  // requires GitHub to *identify* the license (see src/audit/checks.ts), and a
  // custom all-rights-reserved notice can never satisfy it — without this the
  // audit would raise a todo telling the owner to relicense a repo they
  // deliberately kept closed. Defaults to "open" when omitted.
  licensePolicy?: "open" | "all-rights-reserved";
}
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
    // Build artifacts only (source lives in the private nightide-src); the
    // LICENSE is a deliberate all-rights-reserved notice, not an oversight.
    { name: "nightide", repo: "Defiabell/nightide", tags: ["game", "web", "zh", "en"], homepage: "https://defiabell.github.io/nightide/", licensePolicy: "all-rights-reserved" },
    { name: "day-monitor", repo: "Defiabell/day-monitor", tags: ["macos", "tool", "ai", "en"], homepage: "https://defiabell.github.io/day-monitor/" },
    { name: "shotsync", repo: "Defiabell/shotsync", tags: ["selfhosted", "tool", "web", "en"], homepage: "https://shotsync-demo.defiabell.workers.dev" },
    { name: "screen-coach", repo: "Defiabell/screen-coach", tags: ["macos", "tool", "ai", "zh"], homepage: "https://screen-coach-trial.defiabell.workers.dev" },
    { name: "shiling", repo: "Defiabell/shiling", tags: ["game", "web", "zh"], homepage: "https://shiling.pages.dev" },
    { name: "yixi", repo: "Defiabell/yixi", tags: ["selfhosted", "tool", "web", "en"], homepage: "https://yixi-app.pages.dev" },
    { name: "geshuo", repo: "Defiabell/geshuo", tags: ["web", "zh", "ai"], homepage: "https://geshuo.pages.dev" },
    // No homepage: it ships as a downloadable app, not a site, and the homepage
    // check treats an absent configHomepage as "na" rather than a todo.
    // Tagged zh (not en) for the same reason screen-coach is — the README is
    // bilingual but the UI is Chinese, and the tag drives channel suggestions,
    // so claiming en here would keep proposing Show HN / Console.dev.
    { name: "reading-room", repo: "Defiabell/reading-room", tags: ["macos", "tool", "zh"] },
    { name: "beacon", repo: "Defiabell/beacon", tags: ["tool", "web", "selfhosted", "en"], homepage: "https://beacon.defiabell.workers.dev" }
  ],
  // siteTag (not site_token) — the internal id RUM's GraphQL filters on.
  sites: [
    { name: "听风闲语 + 夜潮", host: "defiabell.github.io", siteTag: "679daf9b94fa433aa14020d7a40caf1b" },
    { name: "英文站", host: "defiabell.pages.dev", siteTag: "642a79a267904b0dbc59a7d712a0d32e" },
    { name: "mythmesh", host: "mythmesh.pages.dev", siteTag: "79f96ab6a4fb4226affa009174c939ff" },
    { name: "食灵", host: "shiling.pages.dev", siteTag: "53be0dd64f2a46faa726fac13eb404a6" }
  ]
};
