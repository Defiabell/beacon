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
//
// The exception is a zone-level site (Cloudflare's automatic injection for a
// whole zone): one siteTag then covers the apex and every subdomain. Such an
// entry declares `hosts` — the hostnames expected under it — and the collector
// splits its rows by requestHost so each subdomain is stored as its own site.
// A hostname that shows up but isn't listed is still stored; `hosts` only
// drives zero-filling for quiet days and the name lookup, it is not a filter.
export interface SiteConfig { name: string; host: string; siteTag: string; hosts?: string[]; }

export function isZoneSite(site: SiteConfig): boolean {
  return Array.isArray(site.hosts);
}

// Every hostname a config entry is expected to produce rows for.
export function siteHosts(site: SiteConfig): string[] {
  return site.hosts ?? [site.host];
}

// The config entry a stored site_daily hostname belongs to. A zone-level entry
// claims its apex and any subdomain of it, listed or not, because that is what
// the zone-level injection actually covers.
export function siteFor(sites: SiteConfig[], host: string): SiteConfig | undefined {
  const h = host.toLowerCase();
  return sites.find(s => {
    if (!isZoneSite(s)) return s.host.toLowerCase() === h;
    const apex = s.host.toLowerCase();
    return h === apex || h.endsWith("." + apex) || s.hosts!.some(x => x.toLowerCase() === h);
  });
}
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
    { name: "shotsync", repo: "Defiabell/shotsync", tags: ["selfhosted", "tool", "web", "en"], homepage: "https://shotsync-demo.defiabell.com" },
    { name: "screen-coach", repo: "Defiabell/screen-coach", tags: ["macos", "tool", "ai", "zh"], homepage: "https://screen-coach.defiabell.com" },
    { name: "shiling", repo: "Defiabell/shiling", tags: ["game", "web", "zh"], homepage: "https://shiling.defiabell.com" },
    { name: "yixi", repo: "Defiabell/yixi", tags: ["selfhosted", "tool", "web", "en"], homepage: "https://yixi.defiabell.com" },
    { name: "geshuo", repo: "Defiabell/geshuo", tags: ["web", "zh", "ai"], homepage: "https://geshuo.defiabell.com" },
    // No homepage: it ships as a downloadable app, not a site, and the homepage
    // check treats an absent configHomepage as "na" rather than a todo.
    // Tagged zh (not en) for the same reason screen-coach is — the README is
    // bilingual but the UI is Chinese, and the tag drives channel suggestions,
    // so claiming en here would keep proposing Show HN / Console.dev.
    { name: "reading-room", repo: "Defiabell/reading-room", tags: ["macos", "tool", "zh"] },
    { name: "beacon", repo: "Defiabell/beacon", tags: ["tool", "web", "selfhosted", "en"], homepage: "https://beacon.defiabell.com" },
    // Public since 2026-10-19; the other autumn sites (randeng, kaogu, lost,
    // fanyi, shouye) live in private repos, so they only appear as hosts below.
    { name: "yilian", repo: "Defiabell/yilian", tags: ["web", "zh", "tool"], homepage: "https://yilian.defiabell.com" }
  ],
  // siteTag (not site_token) — the internal id RUM's GraphQL filters on.
  sites: [
    { name: "听风闲语 + 夜潮", host: "defiabell.github.io", siteTag: "679daf9b94fa433aa14020d7a40caf1b" },
    { name: "英文站", host: "defiabell.pages.dev", siteTag: "642a79a267904b0dbc59a7d712a0d32e" },
    { name: "mythmesh", host: "mythmesh.pages.dev", siteTag: "79f96ab6a4fb4226affa009174c939ff" },
    { name: "食灵", host: "shiling.pages.dev", siteTag: "53be0dd64f2a46faa726fac13eb404a6" },
    // Zone-level site created 2026-10-20 with the defiabell.com domain: one tag,
    // auto-injected on every *.defiabell.com host. The old pages.dev /
    // workers.dev addresses above keep their own manual tags, so the two sets
    // never overlap. `hosts` is the current subdomain map (reference:
    // agent-workspace memory reference_defiabell_domain); www is left out on
    // purpose — it 301s to the apex and only produces a stray row now and then.
    {
      name: "defiabell.com（全域）", host: "defiabell.com", siteTag: "2f684bb019964ffda60ebf040fcb010a",
      hosts: [
        "defiabell.com", "island.defiabell.com", "yilian.defiabell.com", "yixi.defiabell.com",
        "mythmesh.defiabell.com", "geshuo.defiabell.com", "shiling.defiabell.com", "gulliver.defiabell.com",
        "shotsync-demo.defiabell.com", "beacon.defiabell.com", "screen-coach.defiabell.com", "comments.defiabell.com",
        // Added 2026-10-29: the late-October launches (private repos, sites only).
        "randeng.defiabell.com", "kaogu.defiabell.com", "lost.defiabell.com", "fanyi.defiabell.com", "shouye.defiabell.com"
      ]
    }
  ]
};
