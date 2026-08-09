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
    expect(todoTitle("readme-links", input)).toBe(`修复 ${input.project} README 断链`);
    expect(todoTitle("social-preview", input)).toBe(`给 ${input.project} 设置 social preview 图`);
    expect(todoTitle("homepage", input)).toBe(`给 ${input.project} 填 homepage 字段`);
  });

  it("readme-links title is STABLE — it does not interpolate the broken-link list, so two different broken-link sets render the identical title", () => {
    const withOneLink = golden();
    withOneLink.brokenLinks = ["https://example.com/a"];
    const withTwoLinks = golden();
    withTwoLinks.brokenLinks = ["https://example.com/b", "https://example.com/c"];
    const withNoLinks = golden();
    withNoLinks.brokenLinks = [];

    const title = `修复 ${withOneLink.project} README 断链`;
    expect(todoTitle("readme-links", withOneLink)).toBe(title);
    expect(todoTitle("readme-links", withTwoLinks)).toBe(title);
    expect(todoTitle("readme-links", withNoLinks)).toBe(title);
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

  it("does not treat trailing markdown emphasis as part of a bare URL", async () => {
    // Real-world regression (nightide README): "**\u25b6 \u5728\u7ebf\u6e38\u73a9: https://example.com/play/**"
    // The closing "**" belongs to the bold span, not the link — swallowing it
    // turned a working page into a phantom P1 "broken link" todo.
    const project = CONFIG.projects[0];
    const readme = "**play now: https://example.com/play/**\n\nsee https://example.com/docs. And https://example.com/x, too.\n";
    const seen: string[] = [];
    const stub: typeof fetch = async (input, init) => {
      const url = String(input);
      if (/\/readme$/.test(url)) return new Response(readme, { status: 200 });
      if (/releases\?per_page=10$/.test(url)) return Response.json([]);
      if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) return Response.json(repoMeta);
      if (/^https:\/\/github\.com\//.test(url)) return new Response("", { status: 200 });
      if (url.startsWith("https://example.com/")) {
        if (init?.method === "HEAD" || !init) seen.push(url);
        // Only the exact, punctuation-free URLs exist.
        const ok = ["https://example.com/play/", "https://example.com/docs", "https://example.com/x"];
        return new Response("", { status: ok.includes(url) ? 200 : 404 });
      }
      return new Response("not found", { status: 404 });
    };
    const input = await collectAuditInput("tok", project, stub);
    expect(seen).toContain("https://example.com/play/");
    expect(seen.some(u => u.includes("*"))).toBe(false);
    expect(seen.some(u => u.endsWith("."))).toBe(false);
    expect(seen.some(u => u.endsWith(","))).toBe(false);
    expect(input.brokenLinks).toEqual([]);
  });

  it("does not skip a github.com lookalike domain from the broken-link check", async () => {
    const base = buildStub();
    // A minimal README with just the lookalike link — not readmeFixture's full
    // link stack (raw.githubusercontent screenshot + docs + broken-page) plus
    // this one, which would overflow MAX_LINKS_CHECKED=3 and silently drop the
    // lookalike link from the check before it's ever reached.
    const withLookalike: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/readme")) {
        return new Response("# shotsync\n\n- Lookalike: https://evilgithub.com/whatever\n", { status: 200 });
      }
      if (url === "https://evilgithub.com/whatever") return new Response("nope", { status: 404 });
      return base(input, init);
    };
    const input = await collectAuditInput("tok", project, withLookalike);
    expect(input.brokenLinks).toContain("https://evilgithub.com/whatever");
  });

  it("checks a link past the raw MAX_LINKS_CHECKED position when github.com self-references occupy the earlier positions", async () => {
    // 22 distinct github.com links (badges/Actions/Issues-style self-references)
    // followed by one external broken link. In raw match order the external
    // link sits at position 23 — way past the (deliberately small,
    // subrequest-budget-driven) MAX_LINKS_CHECKED=3 link budget. The github.com
    // exemption must be applied BEFORE the budget truncation, or these
    // self-references silently consume the whole budget and the real external
    // link never gets checked at all.
    const frontLoadedGithubLinks = Array.from(
      { length: 22 },
      (_, i) => `- https://github.com/Defiabell/shotsync/actions/runs/${i}`
    ).join("\n");
    const readme = `# shotsync\n\n${frontLoadedGithubLinks}\n- External: https://example.com/broken-past-budget\n`;
    const base = buildStub();
    const stub: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://example.com/broken-past-budget") return new Response("nope", { status: 404 });
      if (url.endsWith("/readme")) return new Response(readme, { status: 200 });
      return base(input, init);
    };
    const input = await collectAuditInput("tok", project, stub);
    expect(input.brokenLinks).toEqual(["https://example.com/broken-past-budget"]);
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
      "select check_id as checkId, status, detail from audit_results where project=?1"
    )
      .bind("shotsync")
      .all<{ checkId: string; status: string; detail: string }>();
    const shotsyncChecks = Object.fromEntries(rows.results.map(r => [r.checkId, r]));
    expect(shotsyncChecks.topics.status).toBe("fail");
    expect(shotsyncChecks["readme-links"].status).toBe("fail");
    // the broken-link list lives in detail (rendered on the project page), not the todo title
    expect(shotsyncChecks["readme-links"].detail).toContain("broken-page");

    const todos = await db.listTodos(env.DB, "open");
    const shotsyncTodos = todos.filter(t => t.project === "shotsync");
    expect(shotsyncTodos.some(t => t.title.includes("topics"))).toBe(true);
    const readmeLinksTodo = shotsyncTodos.find(t => t.title.includes("断链"));
    expect(readmeLinksTodo).toBeDefined();
    expect(readmeLinksTodo!.title).toBe("修复 shotsync README 断链");
    expect(readmeLinksTodo!.title).not.toContain("broken-page");

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

  // I2: transient-failure lifecycle. buildStub()'s shotsync README carries a
  // broken link (https://example.com/broken-page -> 404), which fails the
  // readme-links check and opens a todo. A later run where that same link now
  // resolves should auto-close the todo (closeTodoByTitle in src/audit/run.ts)
  // rather than leaving it open forever or creating a second, parallel one.
  it("auto-closes the readme-links todo once the broken link is fixed on a later run, without leaving a stray duplicate", async () => {
    const brokenStub = buildStub();
    await runAudit(env, brokenStub);

    const openAfterFirstRun = (await db.listTodos(env.DB, "open")).filter(
      t => t.project === "shotsync" && t.title.includes("断链")
    );
    expect(openAfterFirstRun).toHaveLength(1);

    const fixedStub: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://example.com/broken-page") return new Response("ok", { status: 200 });
      return brokenStub(input, init);
    };
    await runAudit(env, fixedStub);

    const allShotsyncReadmeLinksTodos = (await db.listTodos(env.DB)).filter(
      t => t.project === "shotsync" && t.title.includes("断链")
    );
    // exactly one row total — closed in place, not superseded by a new one
    expect(allShotsyncReadmeLinksTodos).toHaveLength(1);
    expect(allShotsyncReadmeLinksTodos[0].status).toBe("done");
    expect(allShotsyncReadmeLinksTodos[0].doneAt).not.toBeNull();

    const stillOpen = (await db.listTodos(env.DB, "open")).filter(
      t => t.project === "shotsync" && t.title.includes("断链")
    );
    expect(stillOpen).toHaveLength(0);
  });

  // I2: title stability. Two runs whose README fails readme-links for two
  // DIFFERENT broken links must still collapse onto the same todo row (title
  // no longer embeds the link list — see todoTitle in src/audit/checks.ts) —
  // not proliferate into one todo per distinct broken-link set. Uses a
  // purpose-built minimal README (rather than reusing readmeFixture, which
  // already carries its own https://example.com/broken-page inside the
  // MAX_LINKS_CHECKED=3 budget — appending a link after it would silently
  // never be checked at all) with exactly one external, non-github.com link.
  it("title stability: two runs with different broken-link sets still produce exactly one open todo, not two", async () => {
    const base = buildStub();
    const readmeWithBrokenLink = (url: string) =>
      `# shotsync\n\nA cross-device clipboard and image relay pool for quick sharing across devices.\n\n` +
      `![screenshot](https://github.com/Defiabell/shotsync/blob/main/screenshot.png)\n\n- Broken: ${url}\n`;

    const firstBroken = "https://example.com/broken-page-a";
    const stub1: typeof fetch = async (input, init) => {
      const url = String(input);
      if (/\/readme$/.test(url)) return new Response(readmeWithBrokenLink(firstBroken), { status: 200 });
      if (url === firstBroken) return new Response("nope", { status: 404 });
      return base(input, init);
    };
    await runAudit(env, stub1);

    const secondBroken = "https://example.com/broken-page-b";
    const stub2: typeof fetch = async (input, init) => {
      const url = String(input);
      if (/\/readme$/.test(url)) return new Response(readmeWithBrokenLink(secondBroken), { status: 200 });
      if (url === secondBroken) return new Response("nope", { status: 404 });
      return base(input, init);
    };
    await runAudit(env, stub2);

    const openTodos = (await db.listTodos(env.DB, "open")).filter(
      t => t.project === "shotsync" && t.title.includes("断链")
    );
    expect(openTodos).toHaveLength(1);
    expect(openTodos[0].title).toBe("修复 shotsync README 断链");
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
