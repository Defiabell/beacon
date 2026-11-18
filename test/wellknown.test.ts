import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { CONFIG } from "../src/config";
import { recordSourceRun } from "../src/db";
import { sitemapPaths, sitemapXml } from "../src/api/wellknown";
import { collectWellKnown } from "../src/audit/run";
import { checkWellKnown } from "../src/audit/checks";

const ORIGIN = "https://beacon.internal";
// What the generated files call the site: the configured canonical origin.
const SITE = CONFIG.canonicalOrigin ?? ORIGIN;

describe("well-known files", () => {
  it("robots.txt is plain text and names the sitemap by absolute URL on the canonical origin", async () => {
    const res = await SELF.fetch(`${ORIGIN}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it("sitemap.xml lists the views and one page per configured project, dated by the last collection", async () => {
    await recordSourceRun(env.DB, "rum", true);
    const res = await SELF.fetch(`${ORIGIN}/sitemap.xml`);
    expect(res.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    const xml = await res.text();
    const today = new Date().toISOString().slice(0, 10);
    expect(xml.match(/<url>/g)).toHaveLength(sitemapPaths().length);
    for (const p of CONFIG.projects) expect(xml).toContain(`<loc>${SITE}/p/${p.name}</loc><lastmod>${today}</lastmod>`);
    expect(xml).toContain(`<loc>${SITE}/trends</loc>`);
  });

  it("omits lastmod rather than inventing one before any collection has run", () => {
    const xml = sitemapXml(ORIGIN, null);
    expect(xml).not.toContain("<lastmod>");
    expect(xml).toContain(`<loc>${ORIGIN}/</loc>`);
  });

  it("llms.txt is plain text, not the dashboard's HTML, and links every project", async () => {
    const res = await SELF.fetch(`${ORIGIN}/llms.txt`);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body.startsWith("# beacon")).toBe(true);
    expect(body).not.toContain("<html");
    for (const p of CONFIG.projects) expect(body).toContain(`${SITE}/p/${p.name}`);
  });

  // The point of the exercise: beacon's own audit, run against beacon.
  it("passes beacon's own well-known audit", async () => {
    const probe = await collectWellKnown(ORIGIN, (input, init) => SELF.fetch(new Request(input as string, init as RequestInit)));
    expect(checkWellKnown({ wellKnown: probe } as Parameters<typeof checkWellKnown>[0])).toMatchObject({ status: "pass" });
  });
});

describe("head metadata", () => {
  const head = async (path: string, origin = ORIGIN) => {
    const html = await (await SELF.fetch(`${origin}${path}`)).text();
    return html.slice(0, html.indexOf("</head>"));
  };

  it("names the configured origin as canonical whatever host the request came in on, and drops the query string", async () => {
    const canonical = CONFIG.canonicalOrigin!;
    for (const origin of [ORIGIN, "https://beacon.example.workers.dev"]) {
      const h = await head("/trends?days=7", origin);
      expect(h).toContain(`<link rel="canonical" href="${canonical}/trends">`);
      expect(h).toContain(`<meta property="og:url" content="${canonical}/trends">`);
    }
  });

  it("gives every view a description, a preview image and a title that matches the page's own", async () => {
    for (const path of ["/", "/trends", "/matrix", "/todos", "/posts", "/impact", `/p/${CONFIG.projects[0].name}`, `/s/${CONFIG.sites[0].host}`]) {
      const h = await head(path);
      const title = h.match(/<title>([^<]*)<\/title>/)![1];
      expect(h.match(/<meta name="description" content="([^"]{20,})">/), path).not.toBeNull();
      expect(h).toContain(`<meta property="og:title" content="${title}">`);
      expect(h).toContain(`<meta property="og:image" content="${CONFIG.ogImage}">`);
      expect(h).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(h.match(/rel="canonical"/g), path).toHaveLength(1);
    }
  });

  it("puts the WebSite JSON-LD on the home page only, and it parses", async () => {
    const home = await head("/");
    const ld = JSON.parse(home.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]);
    expect(ld).toMatchObject({ "@type": "WebSite", url: `${CONFIG.canonicalOrigin}/` });
    expect(await head("/trends")).not.toContain("ld+json");
  });
});
