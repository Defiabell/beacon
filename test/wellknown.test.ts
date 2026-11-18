import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { CONFIG } from "../src/config";
import { recordSourceRun } from "../src/db";
import { sitemapPaths, sitemapXml } from "../src/api/wellknown";
import { collectWellKnown } from "../src/audit/run";
import { checkWellKnown } from "../src/audit/checks";

const ORIGIN = "https://beacon.internal";

describe("well-known files", () => {
  it("robots.txt is plain text and names the sitemap by absolute URL on the request's own origin", async () => {
    const res = await SELF.fetch(`${ORIGIN}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it("sitemap.xml lists the views and one page per configured project, dated by the last collection", async () => {
    await recordSourceRun(env.DB, "rum", true);
    const res = await SELF.fetch(`${ORIGIN}/sitemap.xml`);
    expect(res.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    const xml = await res.text();
    const today = new Date().toISOString().slice(0, 10);
    expect(xml.match(/<url>/g)).toHaveLength(sitemapPaths().length);
    for (const p of CONFIG.projects) expect(xml).toContain(`<loc>${ORIGIN}/p/${p.name}</loc><lastmod>${today}</lastmod>`);
    expect(xml).toContain(`<loc>${ORIGIN}/trends</loc>`);
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
    for (const p of CONFIG.projects) expect(body).toContain(`${ORIGIN}/p/${p.name}`);
  });

  // The point of the exercise: beacon's own audit, run against beacon.
  it("passes beacon's own well-known audit", async () => {
    const probe = await collectWellKnown(ORIGIN, (input, init) => SELF.fetch(new Request(input as string, init as RequestInit)));
    expect(checkWellKnown({ wellKnown: probe } as Parameters<typeof checkWellKnown>[0])).toMatchObject({ status: "pass" });
  });
});
