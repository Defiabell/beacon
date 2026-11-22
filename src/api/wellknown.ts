// /robots.txt, /sitemap.xml and /llms.txt for the dashboard itself.
//
// beacon audits every tracked site for exactly these three files (the
// "well-known" check in src/audit/checks.ts) and was failing its own audit:
// the Worker had no route for any of them. They are generated from the same
// config the pages render from, so a project added to src/config.ts shows up
// here without a second list to keep in step.
//
// Absolute URLs use CONFIG.canonicalOrigin when it is set, so the copy of
// these files served on the *.workers.dev address points at the real site
// instead of describing a second one; without it they use the request's own
// origin, so a self-hosted copy advertises itself correctly out of the box.
import type { Env } from "../types";
import { CONFIG } from "../config";
import { listSourceRuns } from "../db";

const CACHE_CONTROL = "public, max-age=3600";

function text(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": contentType, "Cache-Control": CACHE_CONTROL } });
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Every page worth a crawler's visit: the six views plus one page per project. */
export function sitemapPaths(): string[] {
  return ["/", "/trends", "/matrix", "/todos", "/posts", "/impact", ...CONFIG.projects.map(p => `/p/${encodeURIComponent(p.name)}`)];
}

export function robotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}

// `lastmod` is the day the collectors last wrote data, which is when these
// pages last changed. It is omitted (never guessed, never "now") before the
// first collection has run.
export function sitemapXml(origin: string, lastmod: string | null): string {
  const urls = sitemapPaths()
    .map(path => `  <url><loc>${xmlEscape(origin + path)}</loc>${lastmod ? `<lastmod>${xmlEscape(lastmod)}</lastmod>` : ""}</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function llmsTxt(origin: string): string {
  const projects = CONFIG.projects
    .map(p => `- [${p.name}](${origin}/p/${encodeURIComponent(p.name)}): github.com/${p.repo}${p.homepage ? ` · ${p.homepage}` : ""}`)
    .join("\n");
  return `# beacon

> beacon is an open-source dashboard that measures how much attention a set of side projects gets and suggests where to publish them next. It runs as one Cloudflare Worker with a D1 database, collects once a day, and renders every page on the server with no JavaScript. This instance tracks the projects of Jinkun Sun (Defiabell).

Author: Jinkun Sun (Defiabell) · https://defiabell.com/ · https://github.com/Defiabell
Source: https://github.com/Defiabell/beacon (MIT)
Interface language: Chinese

## What it records

- GitHub stars, repository views and clones per day for each tracked repository, and which sites referred visitors to it.
- Page views and visits per day for each tracked website (Cloudflare Web Analytics), and the referrers behind them, including visits that arrive from AI answer engines.
- Request counts per day for the author's Cloudflare Workers and Pages Functions.
- Posts made about each project (V2EX, Hacker News, GitHub issues) and their replies and views over time.
- A ten-point audit of each repository's exposure basics (description, topics, license, README visuals, social preview, robots.txt / sitemap / llms.txt on its site) with a to-do item for each failure.
- An eight-point page audit of each tracked site's homepage and sitemap as a crawler sees it (title and description length, one h1, canonical host, og:image, JSON-LD, visible text, clean sitemap), also with a to-do item for each failure.

Numbers are stored per complete UTC day. A day with no recorded row is shown as a gap, not as zero.

## Pages

- [Overview](${origin}/): the last seven days at a glance, plus this week's suggested actions
- [Trends](${origin}/trends): every metric day by day, over 7, 30 or 90 days
- [Channel matrix](${origin}/matrix): which project has been posted to which channel, and what each channel measurably sent
- [To-dos](${origin}/todos): open and finished audit items
- [Posts](${origin}/posts): registered posts and their current figures
- [Impact](${origin}/impact): each post or finished to-do against the seven days before and after it

## Projects tracked

${projects}

## Data as JSON

- [Overview](${origin}/api/overview)
- [Trends](${origin}/api/trends?days=30): also \`days=7\` and \`days=90\`
- [One project](${origin}/api/project/${encodeURIComponent(CONFIG.projects[0]?.name ?? "name")}): replace the name
- [One site](${origin}/api/site/${CONFIG.sites[0]?.host ?? "host"}?days=30): replace the hostname
- [Collector health](${origin}/api/health)
`;
}

export async function handleWellKnown(req: Request, env: Env, path: string): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const origin = CONFIG.canonicalOrigin ?? new URL(req.url).origin;
  if (path === "/robots.txt") return text(robotsTxt(origin), "text/plain; charset=utf-8");
  if (path === "/llms.txt") return text(llmsTxt(origin), "text/plain; charset=utf-8");
  if (path === "/sitemap.xml") {
    const runs = await listSourceRuns(env.DB);
    const latest = runs.map(r => r.lastRunAt.slice(0, 10)).sort().at(-1) ?? null;
    return text(sitemapXml(origin, latest), "application/xml; charset=utf-8");
  }
  return null;
}
