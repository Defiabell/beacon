import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  DESCRIPTION_WIDTH,
  MIN_TEXT_BYTES,
  PAGE_CHECK_IDS,
  TITLE_WIDTH,
  displayWidth,
  pageTodoTitle,
  parsePage,
  parseSitemap,
  runPageChecks,
  type FetchedResource,
  type PageAuditInput,
  type PageTarget
} from "../src/audit/page-checks";
import {
  PAGE_AUDIT_FETCHES,
  collectPageAuditInput,
  pageAuditShards,
  pageAuditTargets,
  pageTargetCost,
  runPageAudit
} from "../src/audit/page-run";
import { SUBREQUEST_CAP } from "../src/audit/run";
import { SEO_MINUTES } from "../src/schedule";
import { CONFIG, type BeaconConfig } from "../src/config";
import * as db from "../src/db";
import goodHtml from "./fixtures/page-good.htm?raw";
import shellHtml from "./fixtures/page-spa-shell.htm?raw";
import goodSitemap from "./fixtures/sitemap-good.xml?raw";
import badSitemap from "./fixtures/sitemap-bad.xml?raw";

const TARGET: PageTarget = { key: "kaogu.example.com", url: "https://kaogu.example.com/", expectedHost: "kaogu.example.com", exception: {} };

function res(url: string, status: number | null, contentType: string | null, body?: string): FetchedResource {
  return body === undefined ? { url, status, contentType } : { url, status, contentType, body };
}

function golden(): PageAuditInput {
  return {
    target: { ...TARGET, exception: {} },
    page: res("https://kaogu.example.com/", 200, "text/html; charset=utf-8", goodHtml),
    sitemap: res("https://kaogu.example.com/sitemap.xml", 200, "application/xml", goodSitemap),
    ogImage: res("https://kaogu.example.com/og.jpg", 200, "image/jpeg")
  };
}

function byId(input: PageAuditInput) {
  return Object.fromEntries(runPageChecks(input).map(r => [r.checkId, r]));
}

describe("parsePage", () => {
  it("reads the head tags and ignores markup that a browser would not render as content", () => {
    const f = parsePage(goodHtml);
    expect(f.title).toBe("考古 · 五十件展品的故事 | Defiabell");
    expect(f.canonicals).toEqual(["https://kaogu.example.com/"]);
    expect(f.ogImage).toBe("https://kaogu.example.com/og.jpg");
    expect(f.jsonLd).toEqual({ count: 1, errors: [], types: ["WebSite", "Organization"] });
    // The commented-out heading and the one inside a <script> string are not elements.
    expect(f.h1Count).toBe(1);
    expect(f.textBytes).toBeGreaterThanOrEqual(MIN_TEXT_BYTES);
  });

  it("does not count the <head> or script/style bodies as visible text", () => {
    const f = parsePage(shellHtml);
    // Only the <noscript> line would be left, and that is stripped too.
    expect(f.textBytes).toBe(0);
    expect(f.h1Count).toBe(0);
    expect(f.description).toBeNull();
  });

  it("handles attribute order, single quotes, entities and name=og:image", () => {
    const f = parsePage(
      `<head><title>A &amp; B&#39;s &#x4e00;page</title>` +
        `<meta content='Tom &amp; Jerry' name="Description">` +
        `<link href="/x" rel="alternate canonical">` +
        `<meta name="og:image" content="https://a.example/i.png"></head>`
    );
    expect(f.title).toBe("A & B's 一page");
    expect(f.description).toBe("Tom & Jerry");
    expect(f.canonicals).toEqual(["/x"]);
    expect(f.ogImage).toBe("https://a.example/i.png");
  });

  it("an inline SVG's <title> is not the page title", () => {
    expect(parsePage(`<body><svg><title>icon</title></svg></body>`).title).toBeNull();
  });
});

describe("displayWidth", () => {
  it("counts CJK as two and Latin as one", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("考古")).toBe(4);
    expect(displayWidth("一息 (yixi)")).toBe(4 + 7);
    expect(displayWidth("，")).toBe(2);
  });
});

describe("parseSitemap", () => {
  it("reads <loc> values from a urlset and a sitemap index, decoding entities", () => {
    expect(parseSitemap(goodSitemap)).toEqual({
      kind: "urlset",
      locs: ["https://kaogu.example.com/", "https://kaogu.example.com/x/1/", "https://kaogu.example.com/x/2/"]
    });
    expect(parseSitemap(badSitemap).locs[1]).toBe("https://kaogu.example.com/?hall=1&x=2");
    expect(parseSitemap(`<sitemapindex><sitemap><loc><![CDATA[https://a.example/s-0.xml]]></loc></sitemap></sitemapindex>`))
      .toEqual({ kind: "sitemapindex", locs: ["https://a.example/s-0.xml"] });
  });
});

describe("runPageChecks", () => {
  it("passes every check on a compliant page", () => {
    const results = runPageChecks(golden());
    expect(results.map(r => r.checkId)).toEqual([...PAGE_CHECK_IDS]);
    for (const r of results) expect(r.status, `${r.checkId}: ${r.detail}`).toBe("pass");
  });

  it("an SPA shell fails with the specifics a todo needs", () => {
    const input = golden();
    input.page = res("https://lost.example.com/", 200, "text/html", shellHtml);
    input.target = { key: "lost.example.com", url: "https://lost.example.com/", expectedHost: "lost.example.com", exception: {} };
    input.ogImage = null;
    const c = byId(input);
    expect(c["seo-title"].detail).toBe(`<title> too short: width 4 (want ${TITLE_WIDTH.min}–${TITLE_WIDTH.max}, CJK counts 2): "Lost"`);
    expect(c["seo-description"].detail).toBe("no meta description");
    expect(c["seo-h1"].detail).toBe("no <h1> in server HTML");
    expect(c["seo-canonical"].detail).toBe("canonical -> https://lost-site.pages.dev/ (want host lost.example.com)");
    expect(c["seo-og-image"].detail).toBe('og:image is not an absolute URL: "/og.png"');
    expect(c["seo-jsonld"].detail).toMatch(/^JSON-LD does not parse: block 1: /);
    expect(c["seo-text"].detail).toContain(`only 0 bytes of visible text in server HTML (floor ${MIN_TEXT_BYTES})`);
    for (const id of ["seo-title", "seo-description", "seo-h1", "seo-canonical", "seo-og-image", "seo-jsonld", "seo-text"]) {
      expect(c[id].status, id).toBe("fail");
    }
  });

  it("measures title and description length by width, so a Chinese title trips at half the characters", () => {
    const withTitle = (t: string, d = "x".repeat(DESCRIPTION_WIDTH.min)) => {
      const input = golden();
      input.page!.body = goodHtml.replace(/<title>.*<\/title>/, `<title>${t}</title>`).replace(/content="五十件[^"]*"/, `content="${d}"`);
      return byId(input);
    };
    expect(withTitle("a".repeat(TITLE_WIDTH.max))["seo-title"].status).toBe("pass");
    expect(withTitle("考".repeat(TITLE_WIDTH.max / 2))["seo-title"].status).toBe("pass");
    expect(withTitle("考".repeat(TITLE_WIDTH.max / 2 + 1))["seo-title"].detail).toMatch(/^<title> too long: width 72/);
    expect(withTitle("考古")["seo-title"].status).toBe("fail");
    expect(withTitle("考古展品", "短")["seo-description"].detail).toMatch(/^meta description too short: width 2/);
    expect(withTitle("考古五十件展品", "述".repeat(DESCRIPTION_WIDTH.max))["seo-description"].status).toBe("fail");
  });

  it("h1: two is as wrong as none", () => {
    const input = golden();
    input.page!.body = goodHtml.replace("<h1>考古 · 五十件展品</h1>", "<h1>a</h1><h1 class='x'>b</h1>");
    expect(byId(input)["seo-h1"]).toMatchObject({ status: "fail", detail: "2 <h1> elements (want exactly one)" });
  });

  it("canonical: a relative href resolves against the page; an alias can be pointed elsewhere by config", () => {
    const input = golden();
    input.page!.body = goodHtml.replace('href="https://kaogu.example.com/"', 'href="/"');
    expect(byId(input)["seo-canonical"].status).toBe("pass");

    const alias = golden();
    alias.target = { key: "island.example.com", url: "https://island.example.com/", expectedHost: "kaogu.example.com", exception: { canonicalHost: "kaogu.example.com" } };
    alias.page!.url = "https://island.example.com/";
    expect(byId(alias)["seo-canonical"].status).toBe("pass");
    // The alias's sitemap lists the primary host's URLs, which is what it should do.
    expect(byId(alias)["seo-sitemap"].status).toBe("pass");
  });

  it("og:image: an HTML page or a 404 fails, a 5xx or transport error is n/a", () => {
    const html = golden();
    html.ogImage = res("https://kaogu.example.com/og.jpg", 200, "text/html; charset=utf-8");
    expect(byId(html)["seo-og-image"]).toMatchObject({ status: "fail", detail: "og:image https://kaogu.example.com/og.jpg is text/html; charset=utf-8, not an image" });
    const gone = golden();
    gone.ogImage = res("https://kaogu.example.com/og.jpg", 404, "text/html");
    expect(byId(gone)["seo-og-image"].detail).toBe("og:image https://kaogu.example.com/og.jpg -> 404 text/html");
    const down = golden();
    down.ogImage = { url: "https://kaogu.example.com/og.jpg", status: null, contentType: null, error: "connect timeout" };
    expect(byId(down)["seo-og-image"].status).toBe("na");
  });

  it("sitemap: lists query-string and off-host URLs, and fails a missing, HTML or empty sitemap", () => {
    const bad = golden();
    bad.sitemap = res("https://kaogu.example.com/sitemap.xml", 200, "application/xml", badSitemap);
    expect(byId(bad)["seo-sitemap"]).toMatchObject({
      status: "fail",
      detail:
        "/sitemap.xml: 2 URL(s) with a query string: https://kaogu.example.com/?hall=1&x=2, https://kaogu.example.com/?hall=2; " +
        "1 URL(s) not on kaogu.example.com: https://kaogu-old.pages.dev/x/1/"
    });
    const cases: [FetchedResource, string][] = [
      [res("https://kaogu.example.com/sitemap.xml", 404, "text/html", "nope"), "/sitemap.xml -> 404"],
      [res("https://kaogu.example.com/sitemap.xml", 200, "text/html", "<html>"), "/sitemap.xml is text/html (SPA fallback, a fake 200)"],
      [res("https://kaogu.example.com/sitemap.xml", 200, "application/xml", "<urlset></urlset>"), "/sitemap.xml lists no URLs"]
    ];
    for (const [sitemap, detail] of cases) {
      const input = golden();
      input.sitemap = sitemap;
      expect(byId(input)["seo-sitemap"]).toMatchObject({ status: "fail", detail });
    }
  });

  it("every check is n/a when the page cannot be verified or is not a website", () => {
    const cases: PageAuditInput[] = [
      { ...golden(), page: res("https://kaogu.example.com/", 522, "text/html") },
      { ...golden(), page: { url: "https://kaogu.example.com/", status: null, contentType: null, error: "dns" } },
      { ...golden(), page: res("https://kaogu.example.com/", 200, "application/json", "{}") },
      { ...golden(), target: { ...TARGET, exception: { notASite: "API Worker" } }, page: null }
    ];
    for (const input of cases) {
      expect(runPageChecks(input).map(r => r.status)).toEqual(PAGE_CHECK_IDS.map(() => "na"));
    }
    expect(runPageChecks(cases[3])[0].detail).toBe("not a website: API Worker");
  });

  it("a check exempted in config is n/a with the reason, not a todo", () => {
    const input = golden();
    input.page!.body = shellHtml;
    input.target.exception = { skip: { "seo-text": "canvas game, text lives in the 关于 panel" } };
    const c = byId(input);
    expect(c["seo-text"]).toMatchObject({ status: "na", detail: "exempt: canvas game, text lives in the 关于 panel" });
    expect(c["seo-h1"].status).toBe("fail");
  });
});

describe("pageTodoTitle", () => {
  it("names the page and is stable across findings", () => {
    expect(pageTodoTitle("seo-canonical", "kaogu.defiabell.com")).toBe("把 kaogu.defiabell.com 首页的 canonical 指向本站域名");
    for (const id of PAGE_CHECK_IDS) expect(pageTodoTitle(id, "a.example")).toContain("a.example");
    expect(() => pageTodoTitle("nope", "a.example")).toThrow();
  });
});

describe("pageAuditTargets", () => {
  it("covers every zone-level host and every project homepage, once each", () => {
    const targets = pageAuditTargets();
    const keys = targets.map(t => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const site of CONFIG.sites) for (const host of site.hosts ?? []) expect(keys).toContain(host);
    expect(keys).toContain("defiabell.github.io/nightide");
    expect(keys).toContain("defiabell.github.io/day-monitor");
    // shotsync's homepage is also a zone host: one target, not two.
    expect(keys.filter(k => k === "shotsync-demo.defiabell.com")).toHaveLength(1);
  });

  it("applies config exceptions and skips *.workers.dev", () => {
    const config: BeaconConfig = {
      ...CONFIG,
      sites: [{ name: "zone", host: "a.example", siteTag: "t", hosts: ["a.example", "alias.a.example", "api.a.example"] }],
      projects: [
        { name: "p", repo: "o/p", tags: [], homepage: "https://p.someone.workers.dev" },
        { name: "q", repo: "o/q", tags: [], homepage: "https://a.example" }
      ],
      pageAudit: { "alias.a.example": { canonicalHost: "A.example" }, "api.a.example": { notASite: "API" } }
    };
    const targets = pageAuditTargets(config);
    expect(targets.map(t => [t.key, t.expectedHost])).toEqual([
      ["a.example", "a.example"],
      ["alias.a.example", "a.example"],
      ["api.a.example", "api.a.example"]
    ]);
    expect(pageTargetCost(targets[2])).toBe(0);
  });
});

// Answers every page-audit URL with a compliant response, so a run makes the
// maximum number of fetches (the og:image fetch only happens when the page has
// one) — and counts them.
function fleetStub(overrides: (url: string) => Response | null = () => null) {
  let calls = 0;
  const fetchFn: typeof fetch = async input => {
    calls++;
    const url = String(input);
    const o = overrides(url);
    if (o) return o;
    const { host } = new URL(url);
    if (url.endsWith("/robots.txt")) return new Response(`User-agent: *\nSitemap: https://${host}/sitemap.xml\n`, { headers: { "content-type": "text/plain" } });
    if (url.endsWith("/sitemap.xml")) return new Response(`<urlset><url><loc>https://${host}/</loc></url></urlset>`, { headers: { "content-type": "application/xml" } });
    if (url.endsWith("/og.jpg")) return new Response("img", { headers: { "content-type": "image/jpeg" } });
    return new Response(goodHtml.replaceAll("kaogu.example.com", host), { headers: { "content-type": "text/html; charset=utf-8" } });
  };
  return { fetchFn, calls: () => calls, reset: () => { calls = 0; } };
}

describe("page audit subrequest budget", () => {
  it("every shard fits one invocation, and each has a scheduled minute", () => {
    const shards = pageAuditShards();
    expect(shards.length).toBeLessThanOrEqual(SEO_MINUTES.length);
    for (const shard of shards) expect(shard.reduce((n, t) => n + pageTargetCost(t), 0)).toBeLessThanOrEqual(SUBREQUEST_CAP);
    expect(shards.flat().map(t => t.key)).toEqual(pageAuditTargets().map(t => t.key));
  });

  it("a real run never makes more fetches than the formula, and a not-a-site page makes none", async () => {
    const stub = fleetStub();
    const shards = pageAuditShards();
    for (let i = 0; i < shards.length; i++) {
      stub.reset();
      await runPageAudit(env, stub.fetchFn, i);
      const sites = shards[i].filter(t => !t.exception.notASite).length;
      // Equality on the fetch count proper; the redirect allowance in
      // pageTargetCost is headroom for hops a stub cannot produce.
      expect(stub.calls(), `shard ${i}`).toBe(sites * PAGE_AUDIT_FETCHES);
      expect(stub.calls(), `shard ${i}`).toBeLessThanOrEqual(shards[i].reduce((n, t) => n + pageTargetCost(t), 0));
    }
  });
});

describe("collectPageAuditInput", () => {
  it("follows the robots.txt Sitemap: line, on the page's own origin", async () => {
    const seen: string[] = [];
    const stub = fleetStub(url => {
      seen.push(url);
      if (url.endsWith("/robots.txt")) return new Response("Sitemap: https://elsewhere.example/sitemap-index.xml\n", { headers: { "content-type": "text/plain" } });
      return null;
    });
    const input = await collectPageAuditInput(TARGET, stub.fetchFn);
    expect(input.sitemap!.url).toBe("https://kaogu.example.com/sitemap-index.xml");
    expect(seen).toContain("https://kaogu.example.com/og.jpg");
  });

  it("falls back to /sitemap.xml when robots.txt is an SPA fallback, and fetches no image for a relative og:image", async () => {
    const seen: string[] = [];
    const stub = fleetStub(url => {
      seen.push(url);
      if (url.endsWith("/robots.txt")) return new Response("<html>Sitemap: /nope.xml</html>", { headers: { "content-type": "text/html" } });
      if (url === TARGET.url) return new Response(shellHtml, { headers: { "content-type": "text/html" } });
      return null;
    });
    const input = await collectPageAuditInput(TARGET, stub.fetchFn);
    expect(input.sitemap!.url).toBe("https://kaogu.example.com/sitemap.xml");
    expect(input.ogImage).toBeNull();
    expect(seen).toHaveLength(3);
  });

  it("does not fetch anything for a page that is not a website", async () => {
    const stub = fleetStub();
    const input = await collectPageAuditInput({ ...TARGET, exception: { notASite: "API" } }, stub.fetchFn);
    expect(stub.calls()).toBe(0);
    expect(runPageChecks(input).every(r => r.status === "na")).toBe(true);
  });
});

describe("runPageAudit todo lifecycle", () => {
  const KEY = "kaogu.defiabell.com";
  const shardOf = (key: string) => pageAuditShards().findIndex(s => s.some(t => t.key === key));

  it("files results under the page key and opens a todo carrying the current value; a fix closes it", async () => {
    const shard = shardOf(KEY);
    const broken = fleetStub(url => (url === `https://${KEY}/og.jpg` ? new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }) : null));
    await runPageAudit(env, broken.fetchFn, shard);

    const rows = await db.listPageAuditResults(env.DB, KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0].results.find(r => r.checkId === "seo-og-image")!.status).toBe("fail");

    const title = pageTodoTitle("seo-og-image", KEY);
    let todo = (await db.listTodos(env.DB, "open")).find(t => t.title === title)!;
    expect(todo.project).toBe(KEY);
    expect(todo.detail).toBe(`og:image https://${KEY}/og.jpg is text/html, not an image`);

    // Still failing, differently: same row, detail updated.
    const gone = fleetStub(url => (url === `https://${KEY}/og.jpg` ? new Response("", { status: 404, headers: { "content-type": "text/html" } }) : null));
    await runPageAudit(env, gone.fetchFn, shard);
    const open = (await db.listTodos(env.DB, "open")).filter(t => t.title === title);
    expect(open).toHaveLength(1);
    expect(open[0].detail).toBe(`og:image https://${KEY}/og.jpg -> 404 text/html`);

    await runPageAudit(env, fleetStub().fetchFn, shard);
    todo = (await db.listTodos(env.DB)).find(t => t.title === title)!;
    expect(todo.status).toBe("done");
  });

  it("a host with two audited pages lists both on its site page", async () => {
    const shard = shardOf("defiabell.github.io/nightide");
    await runPageAudit(env, fleetStub().fetchFn, shard);
    const groups = await db.listPageAuditResults(env.DB, "defiabell.github.io");
    expect(groups.map(g => g.key)).toEqual(["defiabell.github.io/day-monitor", "defiabell.github.io/nightide"]);
    // Prefix match is per path segment, not per character.
    expect(await db.listPageAuditResults(env.DB, "defiabell.github")).toEqual([]);
  });
});
