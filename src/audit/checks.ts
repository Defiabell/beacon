import type { CheckResult } from "../types";

export interface RepoAuditInput {
  project: string;
  tags: string[];
  // Intended homepage from our own project registry (src/config.ts), as opposed
  // to `meta.homepage` which is what GitHub's repo settings actually report —
  // the `homepage` check compares the two to catch a forgotten sync.
  configHomepage: string | null;
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

function checkLicense(input: RepoAuditInput): CheckResult {
  const pass = input.meta.license !== null;
  return {
    checkId: "license",
    status: pass ? "pass" : "fail",
    priority: 2,
    detail: pass ? `license: ${input.meta.license!.key}` : "no license"
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
    checkHomepage(input)
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
    case "license":
      return `给 ${input.project} 加 LICENSE（建议 MIT）`;
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
    default:
      throw new Error(`unknown check id: ${checkId}`);
  }
}
