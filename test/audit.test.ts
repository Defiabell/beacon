import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { runRepoChecks, todoTitle, type RepoAuditInput } from "../src/audit/checks";
import { collectAuditInput, runAudit } from "../src/audit/run";
import * as db from "../src/db";
import { CONFIG } from "../src/config";
import repoMeta from "./fixtures/gh-repo.json";
import releases from "./fixtures/gh-releases.json";
import readmeFixture from "./fixtures/gh-readme.md?raw";

// A fully-compliant input: every check should pass except release-assets
// (n/a — tags carry no "macos") and homepage (n/a — no configHomepage here).
function golden(): RepoAuditInput {
  return {
    project: "shotsync",
    tags: ["selfhosted", "tool", "web", "en"],
    configHomepage: "https://shotsync.example.com",
    meta: {
      description: "Cross-device clipboard and image relay pool for quick sharing",
      topics: ["clipboard", "selfhosted", "sync"],
      homepage: "https://shotsync.example.com",
      license: { key: "mit" }
    },
    readme:
      "# shotsync\n\nA cross-device clipboard and image relay pool for quick sharing across devices.\n\n![screenshot](https://example.com/shot.png)\n",
    releaseAssetCount: 0,
    ogImageUrl: "https://shotsync.example.com/social-card.png",
    brokenLinks: []
  };
}

function byId(results: ReturnType<typeof runRepoChecks>) {
  return Object.fromEntries(results.map(r => [r.checkId, r]));
}

describe("runRepoChecks", () => {
  it("passes every applicable check on a fully compliant input", () => {
    const results = runRepoChecks(golden());
    expect(results).toHaveLength(9);
    const checks = byId(results);
    expect(checks.description.status).toBe("pass");
    expect(checks.topics.status).toBe("pass");
    expect(checks.license.status).toBe("pass");
    expect(checks["readme-english-intro"].status).toBe("pass");
    expect(checks["readme-visual"].status).toBe("pass");
    expect(checks["release-assets"].status).toBe("na");
    expect(checks["readme-links"].status).toBe("pass");
    expect(checks["social-preview"].status).toBe("pass");
    expect(checks.homepage.status).toBe("pass");
  });

  it("description: fails when empty or under 20 chars, priority 1", () => {
    const short = golden();
    short.meta = { ...short.meta, description: "too short" };
    const shortResult = byId(runRepoChecks(short)).description;
    expect(shortResult.status).toBe("fail");
    expect(shortResult.priority).toBe(1);

    const empty = golden();
    empty.meta = { ...empty.meta, description: null };
    expect(byId(runRepoChecks(empty)).description.status).toBe("fail");
  });

  it("topics: fails with fewer than 3 topics, priority 1", () => {
    const input = golden();
    input.meta = { ...input.meta, topics: ["a", "b"] };
    const result = byId(runRepoChecks(input)).topics;
    expect(result.status).toBe("fail");
    expect(result.priority).toBe(1);
  });

  it("license: fails with no license, priority 2", () => {
    const input = golden();
    input.meta = { ...input.meta, license: null };
    const result = byId(runRepoChecks(input)).license;
    expect(result.status).toBe("fail");
    expect(result.priority).toBe(2);
  });

  it("readme-english-intro: fails when no line in the first 40 has >=30 ASCII letters", () => {
    const input = golden();
    input.readme = "# 项目\n\n这是一个纯中文的项目介绍，完全没有任何英文长句。\n";
    const result = byId(runRepoChecks(input))["readme-english-intro"];
    expect(result.status).toBe("fail");
    expect(result.priority).toBe(1);
  });

  it("readme-visual: fails with no image markup", () => {
    const input = golden();
    input.readme = "# shotsync\n\nJust plain text here, no screenshots or gifs at all.\n";
    const result = byId(runRepoChecks(input))["readme-visual"];
    expect(result.status).toBe("fail");
    expect(result.priority).toBe(1);
  });

  it("release-assets: n/a for non-macos projects regardless of asset count", () => {
    const input = golden();
    input.tags = ["web", "tool"];
    input.releaseAssetCount = 0;
    expect(byId(runRepoChecks(input))["release-assets"].status).toBe("na");
  });

  it("release-assets: fails for macos projects with zero release assets", () => {
    const input = golden();
    input.tags = ["macos", "tool"];
    input.releaseAssetCount = 0;
    const result = byId(runRepoChecks(input))["release-assets"];
    expect(result.status).toBe("fail");
    expect(result.priority).toBe(1);
  });

  it("release-assets: passes for macos projects with release assets present", () => {
    const input = golden();
    input.tags = ["macos", "tool"];
    input.releaseAssetCount = 2;
    expect(byId(runRepoChecks(input))["release-assets"].status).toBe("pass");
  });

  it("readme-links: fails when there are broken links, listing them in detail", () => {
    const input = golden();
    input.brokenLinks = ["https://example.com/broken-page"];
    const result = byId(runRepoChecks(input))["readme-links"];
    expect(result.status).toBe("fail");
    expect(result.priority).toBe(1);
    expect(result.detail).toContain("https://example.com/broken-page");
  });

  it("social-preview: fails when ogImageUrl is null or the generated default asset", () => {
    const noImage = golden();
    noImage.ogImageUrl = null;
    expect(byId(runRepoChecks(noImage))["social-preview"].status).toBe("fail");

    const defaultImage = golden();
    defaultImage.ogImageUrl = "https://opengraph.githubassets.com/1/Defiabell/shotsync";
    const result = byId(runRepoChecks(defaultImage))["social-preview"];
    expect(result.status).toBe("fail");
    expect(result.priority).toBe(2);
  });

  it("homepage: n/a when the project has no configured homepage", () => {
    const input = golden();
    input.configHomepage = null;
    expect(byId(runRepoChecks(input)).homepage.status).toBe("na");
  });

  it("homepage: fails when configured but not synced to GitHub, priority 3", () => {
    const input = golden();
    input.meta = { ...input.meta, homepage: null };
    const result = byId(runRepoChecks(input)).homepage;
    expect(result.status).toBe("fail");
    expect(result.priority).toBe(3);
  });
});

describe("todoTitle", () => {
  it("renders the exact templates from the audit rule table", () => {
    const input = golden();
    expect(todoTitle("description", input)).toBe(`给 ${input.project} 补一句 ≥20 字符的 GitHub description`);
    expect(todoTitle("topics", input)).toBe(`给 ${input.project} 加至少 3 个 topics 标签`);
    expect(todoTitle("license", input)).toBe(`给 ${input.project} 加 LICENSE（建议 MIT）`);
    expect(todoTitle("readme-english-intro", input)).toBe(`在 ${input.project} README 首屏加英文一句话简介`);
    expect(todoTitle("readme-visual", input)).toBe(`给 ${input.project} README 加截图或 GIF`);
    expect(todoTitle("release-assets", input)).toBe(`把 ${input.project} 预编译产物挂到 GitHub Releases`);
    expect(todoTitle("social-preview", input)).toBe(`给 ${input.project} 设置 social preview 图`);
    expect(todoTitle("homepage", input)).toBe(`给 ${input.project} 填 homepage 字段`);
  });

  it("readme-links interpolates the broken link list", () => {
    const input = golden();
    input.brokenLinks = ["https://example.com/a", "https://example.com/b"];
    expect(todoTitle("readme-links", input)).toBe(
      `修复 ${input.project} README 断链：https://example.com/a, https://example.com/b`
    );
  });
});

const SHOTSYNC_REPO = "Defiabell/shotsync";

// Generic stub covering every configured project: readme/releases/meta/og-image
// endpoints all keyed by exact URL pattern (not just substring), so per-project
// requests don't accidentally satisfy each other. shotsync's repo meta is
// deliberately thinned to 1 topic to trigger the "topics" fail rule, and its
// README (fixture) carries one broken link, matching the integration scenario:
// "README with a broken link + missing topics".
function buildStub(): typeof fetch {
  return async input => {
    const url = String(input);
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/readme$/.test(url)) {
      return new Response(readmeFixture, { status: 200 });
    }
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\?per_page=10$/.test(url)) {
      return Response.json(releases);
    }
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) {
      if (url.endsWith(`/repos/${SHOTSYNC_REPO}`)) return Response.json({ ...repoMeta, topics: ["clipboard"] });
      return Response.json(repoMeta);
    }
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url)) {
      return new Response('<meta property="og:image" content="https://opengraph.githubassets.com/1/x">', {
        status: 200
      });
    }
    if (url === "https://example.com/docs") return new Response("ok", { status: 200 });
    if (url === "https://example.com/broken-page") return new Response("nope", { status: 404 });
    // The README's screenshot link is raw.githubusercontent.com, not github.com —
    // it must NOT be skipped by the github.com link-check exemption, so it needs
    // its own (working) stub response here.
    if (url.startsWith("https://raw.githubusercontent.com/")) return new Response("PNGDATA", { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

describe("collectAuditInput", () => {
  const project = CONFIG.projects.find(p => p.repo === SHOTSYNC_REPO)!;

  it("assembles a RepoAuditInput from the meta/readme/releases/og-image/link-check sources", async () => {
    const input = await collectAuditInput("tok", project, buildStub());
    expect(input.project).toBe(project.name);
    expect(input.tags).toEqual(project.tags);
    expect(input.meta.topics).toEqual(["clipboard"]);
    expect(input.readme).toContain("shotsync");
    expect(input.releaseAssetCount).toBe(2);
    expect(input.ogImageUrl).toContain("opengraph.githubassets.com");
    expect(input.brokenLinks).toEqual(["https://example.com/broken-page"]);
    expect(input.brokenLinks.some(u => u.includes("github.com"))).toBe(false);
  });

  it("does not skip a github.com lookalike domain from the broken-link check", async () => {
    const base = buildStub();
    const withLookalike: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/readme")) {
        return new Response(`${readmeFixture}\n- Lookalike: https://evilgithub.com/whatever\n`, { status: 200 });
      }
      if (url === "https://evilgithub.com/whatever") return new Response("nope", { status: 404 });
      return base(input, init);
    };
    const input = await collectAuditInput("tok", project, withLookalike);
    expect(input.brokenLinks).toContain("https://evilgithub.com/whatever");
  });

  it("treats a missing README (404) as an empty string, not a thrown error", async () => {
    const base = buildStub();
    const noReadme: typeof fetch = async (input, init) => {
      const url = String(input);
      if (/\/readme$/.test(url)) return new Response("nope", { status: 404 });
      return base(input, init);
    };
    const input = await collectAuditInput("tok", project, noReadme);
    expect(input.readme).toBe("");
  });

  it("throws when the repo meta fetch fails outright", async () => {
    const base = buildStub();
    const badMeta: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === `https://api.github.com/repos/${SHOTSYNC_REPO}`) return new Response("boom", { status: 500 });
      return base(input, init);
    };
    await expect(collectAuditInput("tok", project, badMeta)).rejects.toThrow(/500/);
  });
});

describe("runAudit", () => {
  it("lands audit_results for every configured project and creates todos for fail checks", async () => {
    await runAudit(env, buildStub());

    const rows = await env.DB.prepare(
      "select check_id as checkId, status from audit_results where project=?1"
    )
      .bind("shotsync")
      .all<{ checkId: string; status: string }>();
    const shotsyncChecks = Object.fromEntries(rows.results.map(r => [r.checkId, r.status]));
    expect(shotsyncChecks.topics).toBe("fail");
    expect(shotsyncChecks["readme-links"]).toBe("fail");

    const todos = await db.listTodos(env.DB, "open");
    const shotsyncTodos = todos.filter(t => t.project === "shotsync");
    expect(shotsyncTodos.some(t => t.title.includes("topics"))).toBe(true);
    expect(shotsyncTodos.some(t => t.title.includes("断链") && t.title.includes("broken-page"))).toBe(true);

    // every configured project got a full set of audit_results rows (isolation smoke check)
    for (const project of CONFIG.projects) {
      const count = await env.DB.prepare("select count(*) as n from audit_results where project=?1")
        .bind(project.name)
        .first<{ n: number }>();
      expect(count!.n).toBeGreaterThan(0);
    }
  });

  it("does not duplicate todos on a second run with unchanged inputs", async () => {
    const stub = buildStub();
    await runAudit(env, stub);
    const firstCount = (await db.listTodos(env.DB)).filter(t => t.project === "shotsync").length;
    expect(firstCount).toBeGreaterThan(0);

    await runAudit(env, stub);
    const secondCount = (await db.listTodos(env.DB)).filter(t => t.project === "shotsync").length;
    expect(secondCount).toBe(firstCount);
  });

  it("isolates a single project's collect failure, still auditing the others, and throws an aggregated error", async () => {
    const failingProject = CONFIG.projects.find(p => p.repo === SHOTSYNC_REPO)!;
    const base = buildStub();
    const oneBadProject: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === `https://api.github.com/repos/${failingProject.repo}`) return new Response("boom", { status: 500 });
      return base(input, init);
    };

    await expect(runAudit(env, oneBadProject)).rejects.toThrow(new RegExp(failingProject.repo));

    // the failing project has no audit_results row...
    const failingCount = await env.DB.prepare("select count(*) as n from audit_results where project=?1")
      .bind(failingProject.name)
      .first<{ n: number }>();
    expect(failingCount!.n).toBe(0);

    // ...but every other configured project still landed its rows
    for (const project of CONFIG.projects) {
      if (project.repo === failingProject.repo) continue;
      const count = await env.DB.prepare("select count(*) as n from audit_results where project=?1")
        .bind(project.name)
        .first<{ n: number }>();
      expect(count!.n).toBeGreaterThan(0);
    }
  });
});
