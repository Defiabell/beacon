import type { CheckResult } from "../types";

export interface RepoAuditInput {
  project: string;
  tags: string[];
  // Intended homepage from our own project registry (src/config.ts), as opposed
  // to `meta.homepage` which is what GitHub's repo settings actually report —
  // the `homepage` check compares the two to catch a forgotten sync.
  configHomepage: string | null;
  // From src/config.ts. "all-rights-reserved" makes the LICENSE check n/a —
  // see checkLicense.
  licensePolicy?: "open" | "all-rights-reserved";
  meta: {
    description: string | null;
    topics: string[];
    homepage: string | null;
    license: { key: string } | null;
  };
  readme: string;
  releaseAssetCount: number;
  ogImageUrl: string | null;
  brokenLinks: string[];
  // What the homepage's well-known files answered — see collectWellKnown in
  // ./run.ts. null when the project has no checkable homepage (none
  // configured, or a *.workers.dev address a Worker cannot reach).
  wellKnown: WellKnownProbe | null;
}

// One well-known file's response, reduced to what the check needs. `status`
// null means the fetch itself failed (DNS, TLS, the Worker-to-same-Worker
// restriction) — not evidence about the file either way.
export interface WellKnownFile {
  url: string;
  status: number | null;
  contentType: string | null;
  // robots.txt only: whether a `Sitemap:` line was present, and its value.
  hasSitemapLine?: boolean;
  sitemapUrl?: string | null;
  error?: string;
}

export interface WellKnownProbe {
  // The site root. A homepage that is not an HTML page (an API Worker such as
  // screen-coach's trial-licence endpoint answers 404 application/json) is
  // not a website, and robots/sitemap/llms.txt are not expected of it.
  root: WellKnownFile;
  robots: WellKnownFile;
  sitemap: WellKnownFile;
  llms: WellKnownFile;
}

const MIN_DESCRIPTION_LENGTH = 20;
const MIN_TOPICS = 3;
const README_INTRO_LINES = 40;
const MIN_INTRO_ASCII_LETTERS = 30;

function countAsciiLetters(line: string): number {
  return (line.match(/[A-Za-z]/g) ?? []).length;
}

function checkDescription(input: RepoAuditInput): CheckResult {
  const desc = input.meta.description ?? "";
  const pass = desc.length >= MIN_DESCRIPTION_LENGTH;
  return {
    checkId: "description",
    status: pass ? "pass" : "fail",
    priority: 1,
    detail: pass ? `description is ${desc.length} chars` : `description missing or under ${MIN_DESCRIPTION_LENGTH} chars (${desc.length})`
  };
}

function checkTopics(input: RepoAuditInput): CheckResult {
  const n = input.meta.topics.length;
  const pass = n >= MIN_TOPICS;
  return {
    checkId: "topics",
    status: pass ? "pass" : "fail",
    priority: 1,
    detail: `${n} topic(s)`
  };
}

// GitHub hands back a license object with key "other" whenever licensee cannot
// match LICENSE to a known license, which happens the moment anything is
// appended to the standard text. The repo then shows no license badge and drops
// out of `license:` search filters — the file is there and does none of the work
// it was added to do. Checking `!== null` passed all three of this fleet's repos
// that were in exactly that state (reading-room, geshuo, nightide), so the check
// has to look at the key, not at the object's existence.
const UNIDENTIFIED_LICENSE_KEYS = new Set(["other", "no-license"]);

function checkLicense(input: RepoAuditInput): CheckResult {
  // A repo that is closed on purpose can never satisfy "GitHub identifies the
  // license", so failing it would mint a todo that can only be closed by
  // relicensing. n/a is the honest status: the check does not apply.
  if (input.licensePolicy === "all-rights-reserved") {
    return { checkId: "license", status: "na", priority: 2, detail: "all-rights-reserved by design" };
  }
  const key = input.meta.license?.key ?? null;
  const pass = key !== null && !UNIDENTIFIED_LICENSE_KEYS.has(key);
  return {
    checkId: "license",
    status: pass ? "pass" : "fail",
    priority: 2,
    detail: pass
      ? `license: ${key}`
      : key === null
        ? "no license"
        : `LICENSE present but GitHub identifies it as "${key}" — the standard text was modified or appended to, so no license badge and no license: search hit`
  };
}

function checkReadmeEnglishIntro(input: RepoAuditInput): CheckResult {
  const lines = input.readme.split("\n").slice(0, README_INTRO_LINES);
  const pass = lines.some(line => countAsciiLetters(line) >= MIN_INTRO_ASCII_LETTERS);
  return {
    checkId: "readme-english-intro",
    status: pass ? "pass" : "fail",
    priority: 1,
    detail: pass
      ? `found a line with >=${MIN_INTRO_ASCII_LETTERS} ASCII letters in the first ${README_INTRO_LINES} lines`
      : `no line in the first ${README_INTRO_LINES} lines has >=${MIN_INTRO_ASCII_LETTERS} ASCII letters`
  };
}

function checkReadmeVisual(input: RepoAuditInput): CheckResult {
  const pass = input.readme.includes("![") || input.readme.includes("<img");
  return {
    checkId: "readme-visual",
    status: pass ? "pass" : "fail",
    priority: 1,
    detail: pass ? "found image markup in README" : "no screenshot/GIF found in README"
  };
}

function checkReleaseAssets(input: RepoAuditInput): CheckResult {
  if (!input.tags.includes("macos")) {
    return { checkId: "release-assets", status: "na", priority: 1, detail: "not a macos project" };
  }
  const pass = input.releaseAssetCount > 0;
  return {
    checkId: "release-assets",
    status: pass ? "pass" : "fail",
    priority: 1,
    detail: pass ? `${input.releaseAssetCount} release asset(s)` : "macos project with no release assets"
  };
}

function checkReadmeLinks(input: RepoAuditInput): CheckResult {
  const pass = input.brokenLinks.length === 0;
  return {
    checkId: "readme-links",
    status: pass ? "pass" : "fail",
    priority: 1,
    detail: pass ? "no broken links" : `${input.brokenLinks.length} broken link(s): ${input.brokenLinks.join(", ")}`
  };
}

function isDefaultSocialPreview(ogImageUrl: string | null): boolean {
  return !ogImageUrl || ogImageUrl.includes("opengraph.githubassets.com");
}

function checkSocialPreview(input: RepoAuditInput): CheckResult {
  const isDefault = isDefaultSocialPreview(input.ogImageUrl);
  return {
    checkId: "social-preview",
    status: isDefault ? "fail" : "pass",
    priority: 2,
    detail: isDefault ? "no custom social preview image set" : `social preview: ${input.ogImageUrl}`
  };
}

function checkHomepage(input: RepoAuditInput): CheckResult {
  if (!input.configHomepage) {
    return { checkId: "homepage", status: "na", priority: 3, detail: "no homepage configured for this project" };
  }
  const pass = !!input.meta.homepage;
  return {
    checkId: "homepage",
    status: pass ? "pass" : "fail",
    priority: 3,
    detail: pass ? `homepage: ${input.meta.homepage}` : "homepage configured but not synced to GitHub repo settings"
  };
}

// A SPA host with a catch-all route answers /robots.txt, /sitemap.xml and
// /llms.txt with the index page: HTTP 200, Content-Type text/html. Every
// crawler reads that as "this site has no robots.txt" while every uptime
// check reads it as fine — a fake 200. Found live on this fleet 2026-11-01:
// shiling.defiabell.com/llms.txt was 200 text/html, and four sites' /sitemap.xml
// 404ed with an HTML body while robots.txt pointed at /sitemap-index.xml.
function isHtml(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("text/html");
}

// A 5xx is the far end (or the path to it) having a bad day, not a statement
// about the file — the same stance the README link check takes. It is also
// what a Worker gets when it fetches a route served by itself: beacon probing
// beacon.defiabell.com answered 522 on all three files (2026-11-01) while an
// ordinary client got 200 text/plain for robots.txt.
function isUnverifiable(f: WellKnownFile): boolean {
  return f.status === null || f.status >= 500;
}

function wellKnownFileProblem(name: string, f: WellKnownFile): string | null {
  if (isUnverifiable(f)) return null; // handled by the caller
  if (f.status! < 200 || f.status! >= 300) return `${name} -> ${f.status}`;
  if (isHtml(f.contentType)) return `${name} is text/html (SPA fallback, a fake 200)`;
  return null;
}

export function checkWellKnown(input: RepoAuditInput): CheckResult {
  const probe = input.wellKnown;
  if (!probe) {
    return { checkId: "well-known", status: "na", priority: 2, detail: "no checkable homepage for this project" };
  }
  if (isUnverifiable(probe.root)) {
    return {
      checkId: "well-known",
      status: "na",
      priority: 2,
      detail: `unverifiable from a Worker: site root (${probe.root.error ?? `HTTP ${probe.root.status}`})`
    };
  }
  if (probe.root.status! < 200 || probe.root.status! >= 300 || !isHtml(probe.root.contentType)) {
    return {
      checkId: "well-known",
      status: "na",
      priority: 2,
      detail: `site root is not an HTML page (HTTP ${probe.root.status}, ${probe.root.contentType ?? "no content-type"}) — an API endpoint, not a website`
    };
  }
  const files: [string, WellKnownFile][] = [["robots.txt", probe.robots], ["sitemap", probe.sitemap], ["llms.txt", probe.llms]];
  // A transport failure or a 5xx on any file is not a verdict on the site.
  // Failing here would mint a todo for a site that is fine, which this audit
  // has done enough times already (see ./run.ts's link-check history).
  const unreachable = files.filter(([, f]) => isUnverifiable(f));
  if (unreachable.length > 0) {
    return {
      checkId: "well-known",
      status: "na",
      priority: 2,
      detail: `unverifiable from a Worker: ${unreachable.map(([n, f]) => `${n} (${f.error ?? `HTTP ${f.status}`})`).join(", ")}`
    };
  }
  const problems = files.map(([n, f]) => wellKnownFileProblem(n, f)).filter((p): p is string => p !== null);
  if (probe.robots.status !== null && probe.robots.status >= 200 && probe.robots.status < 300 && !isHtml(probe.robots.contentType) && !probe.robots.hasSitemapLine) {
    problems.push("robots.txt has no Sitemap: line");
  }
  const pass = problems.length === 0;
  return {
    checkId: "well-known",
    status: pass ? "pass" : "fail",
    priority: 2,
    detail: pass
      ? `robots.txt, ${probe.sitemap.url.replace(/^https?:\/\/[^/]+/, "")} and llms.txt all answer non-HTML`
      : problems.join("; ")
  };
}

export function runRepoChecks(input: RepoAuditInput): CheckResult[] {
  return [
    checkDescription(input),
    checkTopics(input),
    checkLicense(input),
    checkReadmeEnglishIntro(input),
    checkReadmeVisual(input),
    checkReleaseAssets(input),
    checkReadmeLinks(input),
    checkSocialPreview(input),
    checkHomepage(input),
    checkWellKnown(input)
  ];
}

// Renders the exact todo-title templates from the audit rule table (task-9-brief.md),
// substituting {repo} with the project name. Only meaningful for a checkId that
// actually failed.
//
// Every title is STABLE across runs for a given (project, checkId) — in
// particular readme-links does NOT interpolate the broken-link list (that
// list lives in the CheckResult.detail instead, rendered on the project page).
// A title that varied with run-specific data (like the broken-link set) would
// defeat both the todos_unique index's dedup (src/db.ts's insertTodoIfNew) —
// a different link set would look like a brand-new todo instead of the same
// recurring one — and closeTodoByTitle's auto-close in src/audit/run.ts, which
// matches the fail-run's title against the later pass-run's title verbatim.
export function todoTitle(checkId: string, input: RepoAuditInput): string {
  switch (checkId) {
    case "description":
      return `给 ${input.project} 补一句 ≥20 字符的 GitHub description`;
    case "topics":
      return `给 ${input.project} 加至少 3 个 topics 标签`;
    // One title for both failure modes (no file, and a file GitHub can't
    // identify). Branching the wording on input.meta would make the title a
    // function of current state, and insertTodoIfNew/closeTodoByTitle key on
    // the title — a repo moving between the two states would then orphan its
    // old open todo instead of closing it.
    case "license":
      return `给 ${input.project} 配一个 GitHub 能识别的 LICENSE（建议 MIT，原文别改）`;
    case "readme-english-intro":
      return `在 ${input.project} README 首屏加英文一句话简介`;
    case "readme-visual":
      return `给 ${input.project} README 加截图或 GIF`;
    case "release-assets":
      return `把 ${input.project} 预编译产物挂到 GitHub Releases`;
    case "readme-links":
      return `修复 ${input.project} README 断链`;
    case "social-preview":
      return `给 ${input.project} 设置 social preview 图`;
    case "homepage":
      return `给 ${input.project} 填 homepage 字段`;
    // One title for every failure mode (missing file, HTML fake 200, robots
    // without a Sitemap line) — same reasoning as "license": the title keys
    // the todo's identity, the specifics live in CheckResult.detail.
    case "well-known":
      return `给 ${input.project} 站点补齐 robots.txt / sitemap / llms.txt（不能是 HTML 假 200）`;
    default:
      throw new Error(`unknown check id: ${checkId}`);
  }
}
