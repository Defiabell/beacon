import type { CheckResult } from "../types";
import type { PageAuditException } from "../config";

// Page-level SEO checks: what a crawler sees in a site's server-rendered
// homepage and its sitemap. The repo checks in ./checks.ts only cover projects
// with a GitHub repo; most of this fleet's sites live in private repos, so
// these run per site (see ./page-run.ts for which sites and how they are
// sharded). Same contract as the repo checks: pure functions over what was
// fetched, pass/fail/na, and a stable todo title per (site, check) with the
// specifics in `detail`.

export const PAGE_CHECK_IDS = [
  "seo-title",
  "seo-description",
  "seo-h1",
  "seo-canonical",
  "seo-og-image",
  "seo-jsonld",
  "seo-text",
  "seo-sitemap"
] as const;
export type PageCheckId = (typeof PAGE_CHECK_IDS)[number];

// One page the audit looks at. `key` is what the results and todos are filed
// under: the hostname, or hostname + path for a homepage that lives under a
// path (defiabell.github.io/nightide) — two projects share that host.
export interface PageTarget {
  key: string;
  url: string;
  // The host canonical and sitemap URLs are supposed to name. Normally the
  // page's own host; an exception can point an alias at its primary address.
  expectedHost: string;
  exception: PageAuditException;
}

// One response, reduced to what a check needs. `status` null means the fetch
// itself failed — not evidence about the resource either way (same stance as
// WellKnownFile in ./checks.ts).
export interface FetchedResource {
  url: string;
  status: number | null;
  contentType: string | null;
  body?: string;
  error?: string;
}

export interface PageAuditInput {
  target: PageTarget;
  page: FetchedResource | null; // null: not fetched (the exception says it is not a site)
  sitemap: FetchedResource | null;
  // null when the page has no og:image tag (or the tag is not an absolute URL),
  // so there was nothing to fetch.
  ogImage: FetchedResource | null;
}

// ---- parsing ---------------------------------------------------------------
//
// Regex rather than a DOM: the Workers runtime has no DOMParser, HTMLRewriter
// is streaming-only and awkward to unit-test, and every question asked here is
// about a handful of head tags plus a byte count. The one real trap — markup
// inside <script> (a JSON blob or template literal containing "<h1>") — is
// handled by stripping script/style/template bodies before counting anything
// in the body.

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });
}

function collapse(s: string): string {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function tags(html: string, name: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map(m => parseAttrs(m[0]));
}

function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
}

export interface PageFacts {
  title: string | null;
  description: string | null;
  h1Count: number;
  canonicals: string[]; // raw href values, in document order
  ogImage: string | null; // raw content value
  jsonLd: { count: number; errors: string[]; types: string[] };
  textBytes: number;
}

function jsonLdTypes(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) jsonLdTypes(v, out);
    return;
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const t = o["@type"];
    if (typeof t === "string") out.add(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") out.add(x);
    if (o["@graph"]) jsonLdTypes(o["@graph"], out);
  }
}

export function parsePage(html: string): PageFacts {
  // Comments first, so a commented-out <title> or <h1> does not count.
  const noComments = html.replace(/<!--[\s\S]*?-->/g, " ");
  const titleMatch = noComments
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, " ") // an inline SVG's <title> is a tooltip, not the page title
    .match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const metas = tags(noComments, "meta");
  const description = metas.find(m => (m.name ?? "").toLowerCase() === "description")?.content ?? null;
  const ogImage =
    metas.find(m => (m.property ?? "").toLowerCase() === "og:image" || (m.name ?? "").toLowerCase() === "og:image")?.content ?? null;
  const canonicals = tags(noComments, "link")
    .filter(l => (l.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"))
    .map(l => l.href ?? "");

  const jsonLd = { count: 0, errors: [] as string[], types: [] as string[] };
  const types = new Set<string>();
  for (const m of noComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if ((parseAttrs(m[1]).type ?? "").toLowerCase() !== "application/ld+json") continue;
    jsonLd.count++;
    try {
      jsonLdTypes(JSON.parse(m[2]), types);
    } catch (e) {
      jsonLd.errors.push(`block ${jsonLd.count}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  jsonLd.types = [...types];

  // Visible text = the body with every non-rendered element and every tag
  // removed. The <head> goes too, so the <title> does not count as content.
  const body = stripNonContent(noComments).replace(/<head\b[\s\S]*?<\/head\s*>/i, " ");
  const h1Count = (body.match(/<h1\b/gi) ?? []).length;
  const text = collapse(body.replace(/<[^>]*>/g, " "));

  return {
    title: titleMatch ? collapse(titleMatch[1]) : null,
    description: description === null ? null : collapse(description),
    h1Count,
    canonicals,
    ogImage: ogImage === null ? null : ogImage.trim(),
    jsonLd,
    textBytes: new TextEncoder().encode(text).length
  };
}

export interface SitemapFacts {
  kind: "urlset" | "sitemapindex" | null;
  locs: string[];
}

export function parseSitemap(xml: string): SitemapFacts {
  const kind = /<urlset\b/i.test(xml) ? "urlset" : /<sitemapindex\b/i.test(xml) ? "sitemapindex" : null;
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi)].map(m => decodeEntities(m[1].trim()));
  return { kind, locs };
}

// ---- lengths ---------------------------------------------------------------

// Search results truncate titles and snippets by rendered pixel width, not by
// character count, and a CJK glyph is about as wide as two Latin letters. So
// lengths are measured in "width": 2 per CJK / kana / hangul / full-width
// character, 1 per anything else. That lets one threshold serve both the
// Chinese sites and the English ones; a character count would let a Chinese
// title run twice as long on screen as an English one before it trips.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u;

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

// <title>: Google shows roughly 600px, about 60 width units, before cutting
// with an ellipsis. The ceiling is 70, not 60, because these titles end in a
// " · Defiabell"-style suffix and losing that to the ellipsis costs nothing;
// past 70 it is the part that says what the page is that gets cut. The floor
// of 10 (five Chinese characters, or ten letters) is below every real title on
// the fleet at 2026-11-22 and above a bare name like "考古" — a title that
// short gives a searcher nothing to choose the result by.
export const TITLE_WIDTH = { min: 10, max: 70 } as const;

// meta description: Google cuts the snippet near 160 width units on desktop,
// and with a description under ~50 (25 Chinese characters) it usually ignores
// it and quotes page text of its own choosing instead — the 2026-11-18 manual
// pass lengthened four sites' descriptions for exactly that. The ceiling is a
// generous 320: longer copy is truncated, not penalised, so this only catches
// a whole introduction pasted into the tag.
export const DESCRIPTION_WIDTH = { min: 50, max: 320 } as const;

// Visible text in the server HTML, in UTF-8 bytes (a Chinese character is 3).
// A client-rendered shell — an empty <div id="root">, a canvas, a <noscript>
// line — comes in at 0–200, and crawlers that do not run JavaScript (most AI
// crawlers, and Google's first pass) see nothing else. Measured on the fleet
// 2026-11-22: the content sites sit at 1,100–9,800 (mythmesh lowest at 1,120),
// the two app UIs whose server text is only button labels at 412 and 590, the
// GitHub Pages stubs at 0 and 39. 800 sits in the middle of the gap, so a page
// gaining or losing a sentence does not flip the todo open and shut.
export const MIN_TEXT_BYTES = 800;

// ---- checks ----------------------------------------------------------------

const PRIORITY: Record<PageCheckId, 1 | 2 | 3> = {
  "seo-title": 1,
  "seo-canonical": 1,
  "seo-text": 1,
  "seo-description": 2,
  "seo-h1": 2,
  "seo-og-image": 2,
  "seo-sitemap": 2,
  "seo-jsonld": 3
};

function result(checkId: PageCheckId, status: CheckResult["status"], detail: string): CheckResult {
  return { checkId, status, priority: PRIORITY[checkId], detail };
}

function quote(s: string, max = 60): string {
  return `"${s.length > max ? `${s.slice(0, max)}…` : s}"`;
}

function isUnverifiable(r: FetchedResource): boolean {
  return r.status === null || r.status >= 500;
}

function isHtml(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("text/html");
}

function hostOf(url: string, base?: string): string | null {
  try {
    return new URL(url, base).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function lengthCheck(
  checkId: PageCheckId,
  label: string,
  value: string | null,
  bounds: { min: number; max: number }
): CheckResult {
  if (value === null || value === "") return result(checkId, "fail", `no ${label}`);
  const w = displayWidth(value);
  const range = `${bounds.min}–${bounds.max}`;
  if (w < bounds.min) return result(checkId, "fail", `${label} too short: width ${w} (want ${range}, CJK counts 2): ${quote(value)}`);
  if (w > bounds.max) return result(checkId, "fail", `${label} too long: width ${w} (want ${range}, CJK counts 2): ${quote(value)}`);
  return result(checkId, "pass", `${label} width ${w}: ${quote(value)}`);
}

function checkCanonical(facts: PageFacts, page: FetchedResource, expectedHost: string): CheckResult {
  const hrefs = [...new Set(facts.canonicals)];
  if (hrefs.length === 0) return result("seo-canonical", "fail", `no <link rel="canonical"> (want one on ${expectedHost})`);
  if (hrefs.length > 1) return result("seo-canonical", "fail", `${hrefs.length} different canonicals: ${hrefs.join(", ")}`);
  const host = hostOf(hrefs[0], page.url);
  if (host === null) return result("seo-canonical", "fail", `canonical is not a URL: ${quote(hrefs[0])}`);
  if (host !== expectedHost) return result("seo-canonical", "fail", `canonical -> ${hrefs[0]} (want host ${expectedHost})`);
  return result("seo-canonical", "pass", `canonical -> ${hrefs[0]}`);
}

function checkOgImage(facts: PageFacts, image: FetchedResource | null): CheckResult {
  if (!facts.ogImage) return result("seo-og-image", "fail", "no og:image");
  // Facebook, X, Slack and WeChat all read og:image literally; a relative path
  // is a broken image there even if a browser would resolve it.
  if (!isAbsoluteHttp(facts.ogImage)) return result("seo-og-image", "fail", `og:image is not an absolute URL: ${quote(facts.ogImage)}`);
  if (!image) return result("seo-og-image", "na", "og:image was not fetched");
  if (isUnverifiable(image)) {
    return result("seo-og-image", "na", `unverifiable from a Worker: ${image.url} (${image.error ?? `HTTP ${image.status}`})`);
  }
  const type = image.contentType ?? "no content-type";
  if (image.status! < 200 || image.status! >= 300) return result("seo-og-image", "fail", `og:image ${image.url} -> ${image.status} ${type}`);
  if (!type.toLowerCase().startsWith("image/")) return result("seo-og-image", "fail", `og:image ${image.url} is ${type}, not an image`);
  return result("seo-og-image", "pass", `og:image ${image.url} (${type})`);
}

function checkJsonLd(facts: PageFacts): CheckResult {
  const { count, errors, types } = facts.jsonLd;
  if (count === 0) return result("seo-jsonld", "fail", 'no <script type="application/ld+json">');
  if (errors.length > 0) return result("seo-jsonld", "fail", `JSON-LD does not parse: ${errors.join("; ")}`);
  return result("seo-jsonld", "pass", `${count} block(s)${types.length ? `: ${types.join(", ")}` : ""}`);
}

function checkText(facts: PageFacts): CheckResult {
  const pass = facts.textBytes >= MIN_TEXT_BYTES;
  return result(
    "seo-text",
    pass ? "pass" : "fail",
    pass
      ? `${facts.textBytes} bytes of visible text in server HTML`
      : `only ${facts.textBytes} bytes of visible text in server HTML (floor ${MIN_TEXT_BYTES}) — crawlers that skip JavaScript see an empty shell`
  );
}

const SAMPLE = 3;

function sample(urls: string[]): string {
  return urls.slice(0, SAMPLE).join(", ") + (urls.length > SAMPLE ? ` (+${urls.length - SAMPLE} more)` : "");
}

export function checkSitemap(sitemap: FetchedResource | null, expectedHost: string): CheckResult {
  if (!sitemap) return result("seo-sitemap", "na", "sitemap was not fetched");
  const path = sitemap.url.replace(/^https?:\/\/[^/]+/, "");
  if (isUnverifiable(sitemap)) return result("seo-sitemap", "na", `unverifiable from a Worker: ${path} (${sitemap.error ?? `HTTP ${sitemap.status}`})`);
  if (sitemap.status! < 200 || sitemap.status! >= 300) return result("seo-sitemap", "fail", `${path} -> ${sitemap.status}`);
  if (isHtml(sitemap.contentType)) return result("seo-sitemap", "fail", `${path} is text/html (SPA fallback, a fake 200)`);
  const facts = parseSitemap(sitemap.body ?? "");
  if (!facts.kind) return result("seo-sitemap", "fail", `${path} is not a sitemap (no <urlset> or <sitemapindex>)`);
  if (facts.locs.length === 0) return result("seo-sitemap", "fail", `${path} lists no URLs`);
  const problems: string[] = [];
  // A query-string URL is a duplicate of its path as far as Google is
  // concerned: on these single-route SPAs `/?c=x` and `/?c=y` serve the same
  // HTML, so listing them only spends crawl budget (方志 had 31 of them).
  const withQuery = facts.locs.filter(u => u.includes("?"));
  if (withQuery.length) problems.push(`${withQuery.length} URL(s) with a query string: ${sample(withQuery)}`);
  // A sitemap may only list URLs on its own host; Google drops the rest, and
  // an old *.pages.dev address listed here is a duplicate being advertised.
  const offHost = facts.locs.filter(u => hostOf(u) !== expectedHost);
  if (offHost.length) problems.push(`${offHost.length} URL(s) not on ${expectedHost}: ${sample(offHost)}`);
  if (problems.length) return result("seo-sitemap", "fail", `${path}: ${problems.join("; ")}`);
  return result(
    "seo-sitemap",
    "pass",
    facts.kind === "sitemapindex"
      ? `${path}: sitemap index of ${facts.locs.length} sitemap(s) on ${expectedHost} (children not fetched)`
      : `${path}: ${facts.locs.length} URL(s), all on ${expectedHost}, none with a query string`
  );
}

function allNa(detail: string): CheckResult[] {
  return PAGE_CHECK_IDS.map(id => result(id, "na", detail));
}

export function runPageChecks(input: PageAuditInput): CheckResult[] {
  const { target, page } = input;
  if (target.exception.notASite) return allNa(`not a website: ${target.exception.notASite}`);
  if (!page) return allNa("page was not fetched");
  // Same stance as the well-known check: a transport failure or 5xx (including
  // the 522 a Worker gets fetching a route it serves itself) is not a verdict
  // on the site, and a root that is not HTML is not a website.
  if (isUnverifiable(page)) return allNa(`unverifiable from a Worker: ${page.url} (${page.error ?? `HTTP ${page.status}`})`);
  if (page.status! < 200 || page.status! >= 300 || !isHtml(page.contentType)) {
    return allNa(`${page.url} is not an HTML page (HTTP ${page.status}, ${page.contentType ?? "no content-type"})`);
  }
  const facts = parsePage(page.body ?? "");
  const h1 = facts.h1Count;
  const results: CheckResult[] = [
    lengthCheck("seo-title", "<title>", facts.title, TITLE_WIDTH),
    lengthCheck("seo-description", "meta description", facts.description, DESCRIPTION_WIDTH),
    result(
      "seo-h1",
      h1 === 1 ? "pass" : "fail",
      h1 === 1 ? "one <h1>" : h1 === 0 ? "no <h1> in server HTML" : `${h1} <h1> elements (want exactly one)`
    ),
    checkCanonical(facts, page, target.expectedHost),
    checkOgImage(facts, input.ogImage),
    checkJsonLd(facts),
    checkText(facts),
    checkSitemap(input.sitemap, target.expectedHost)
  ];
  // Intentional exceptions come from config, so a site that deliberately goes
  // without something reads n/a with the reason rather than a todo the owner
  // has to keep dismissing.
  const skip = target.exception.skip ?? {};
  return results.map(r => {
    const reason = skip[r.checkId as PageCheckId];
    return reason ? { ...r, status: "na" as const, detail: `exempt: ${reason}` } : r;
  });
}

// Stable per (page, check), like todoTitle in ./checks.ts: the title is the
// todo's identity for dedup and auto-close, so it never carries the current
// value — that lives in the result's detail, which the todo row also stores.
export function pageTodoTitle(checkId: string, key: string): string {
  switch (checkId) {
    case "seo-title":
      return `给 ${key} 首页写一个长度合适的 <title>`;
    case "seo-description":
      return `给 ${key} 首页写一段长度合适的 meta description`;
    case "seo-h1":
      return `让 ${key} 首页的服务端 HTML 恰好有一个 <h1>`;
    case "seo-canonical":
      return `把 ${key} 首页的 canonical 指向本站域名`;
    case "seo-og-image":
      return `给 ${key} 首页配一张能打开的 og:image 分享图`;
    case "seo-jsonld":
      return `给 ${key} 首页补上能解析的 JSON-LD`;
    case "seo-text":
      return `给 ${key} 首页的服务端 HTML 补可见文字（不能只是 SPA 空壳）`;
    case "seo-sitemap":
      return `清理 ${key} 的 sitemap（非空、不带 ?、不指向别的域名）`;
    default:
      throw new Error(`unknown page check id: ${checkId}`);
  }
}
