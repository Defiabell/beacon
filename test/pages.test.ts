import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  normalizePagesFunctionsRows,
  fetchPagesFunctionsDaily,
  normalizePagesProjects,
  fetchPagesProjects,
  resolvePagesFunctionsToWorkerDaily
} from "../src/collect/pages";
import { upsertWorkerDaily, getWorkerTotals } from "../src/db";

// Shaped exactly like a real response from the account (verified live against
// pagesFunctionsInvocationsAdaptiveGroups on 2026-09-15): yixi-app's Pages
// Functions script did 7,585 requests while its helper Worker `yixi` showed
// only 19 over the same window — the traffic that motivated this collector.
const REAL_FUNCTIONS_SHAPE = {
  data: {
    viewer: {
      accounts: [
        {
          pagesFunctionsInvocationsAdaptiveGroups: [
            { sum: { requests: 7585, errors: 3 }, dimensions: { scriptName: "pages-worker--18671371-production", date: "2026-09-08" } },
            { sum: { requests: 5, errors: 0 }, dimensions: { scriptName: "pages-worker--18682261-production", date: "2026-09-10" } }
          ]
        }
      ]
    }
  }
};

// Shaped like a real `GET /accounts/{acc}/pages/projects` response (verified
// live 2026-09-15), trimmed to the fields this collector reads.
const REAL_PROJECTS_SHAPE = {
  success: true,
  result: [
    { name: "yixi-app", subdomain: "yixi-app.pages.dev", production_script_name: "pages-worker--18671371-production" },
    { name: "geshuo", subdomain: "geshuo.pages.dev", production_script_name: "pages-worker--18682261-production" },
    // A project with no Functions traffic (uses_functions: false live) still
    // resolves fine — it simply never appears as a scriptName in the
    // Functions dataset, so it contributes no rows.
    { name: "mythmesh", subdomain: "mythmesh.pages.dev", production_script_name: "pages-worker--17866772-production" }
  ],
  result_info: { page: 1, per_page: 25, count: 3, total_count: 3, total_pages: 1 }
};

describe("normalizePagesFunctionsRows", () => {
  it("maps the live response shape", () => {
    expect(normalizePagesFunctionsRows(REAL_FUNCTIONS_SHAPE)).toEqual([
      { scriptName: "pages-worker--18671371-production", date: "2026-09-08", requests: 7585, errors: 3 },
      { scriptName: "pages-worker--18682261-production", date: "2026-09-10", requests: 5, errors: 0 }
    ]);
  });

  it("drops a row missing either primary-key dimension rather than inventing one", () => {
    const rows = normalizePagesFunctionsRows({
      data: { viewer: { accounts: [{ pagesFunctionsInvocationsAdaptiveGroups: [
        { sum: { requests: 5 }, dimensions: { date: "2026-09-08" } },                              // no scriptName
        { sum: { requests: 5 }, dimensions: { scriptName: "pages-worker--1-production" } },         // no date
        { sum: { requests: 5 }, dimensions: { scriptName: "pages-worker--1-production", date: "2026-09-08" } }
      ] }] } }
    });
    expect(rows).toEqual([{ scriptName: "pages-worker--1-production", date: "2026-09-08", requests: 5, errors: 0 }]);
  });

  it("defaults absent numeric fields to 0 instead of NaN", () => {
    const rows = normalizePagesFunctionsRows({
      data: { viewer: { accounts: [{ pagesFunctionsInvocationsAdaptiveGroups: [
        { sum: {}, dimensions: { scriptName: "pages-worker--1-production", date: "2026-09-08" } }
      ] }] } }
    });
    expect(rows[0]).toEqual({ scriptName: "pages-worker--1-production", date: "2026-09-08", requests: 0, errors: 0 });
  });

  it("returns [] for every malformed envelope rather than throwing", () => {
    for (const bad of [null, undefined, 42, "nope", {}, { data: {} }, { data: { viewer: { accounts: [] } } }]) {
      expect(normalizePagesFunctionsRows(bad)).toEqual([]);
    }
  });
});

describe("fetchPagesFunctionsDaily", () => {
  it("throws on a GraphQL errors array instead of reporting zero traffic", async () => {
    const stub: typeof fetch = async () =>
      Response.json({ errors: [{ message: "Authentication error" }], data: null });
    await expect(fetchPagesFunctionsDaily("acc", "tok", "2026-09-08", "2026-09-15", stub)).rejects.toThrow(/Authentication error/);
  });

  it("throws on a non-2xx response", async () => {
    const stub: typeof fetch = async () => new Response("nope", { status: 403 });
    await expect(fetchPagesFunctionsDaily("acc", "tok", "2026-09-08", "2026-09-15", stub)).rejects.toThrow(/403/);
  });

  it("sends the account tag and date range as GraphQL variables", async () => {
    let seen: any = null;
    const stub: typeof fetch = async (_u, init) => {
      seen = JSON.parse(String(init?.body));
      return Response.json(REAL_FUNCTIONS_SHAPE);
    };
    const rows = await fetchPagesFunctionsDaily("acc-123", "tok", "2026-09-08", "2026-09-15", stub);
    expect(seen.variables).toEqual({ acc: "acc-123", start: "2026-09-08", end: "2026-09-15" });
    expect(rows).toHaveLength(2);
  });
});

describe("normalizePagesProjects", () => {
  it("maps the live response shape", () => {
    expect(normalizePagesProjects(REAL_PROJECTS_SHAPE)).toEqual([
      { name: "yixi-app", subdomain: "yixi-app.pages.dev", productionScriptName: "pages-worker--18671371-production" },
      { name: "geshuo", subdomain: "geshuo.pages.dev", productionScriptName: "pages-worker--18682261-production" },
      { name: "mythmesh", subdomain: "mythmesh.pages.dev", productionScriptName: "pages-worker--17866772-production" }
    ]);
  });

  it("drops a project missing subdomain or production_script_name rather than guessing one", () => {
    const projects = normalizePagesProjects({
      success: true,
      result: [
        { name: "no-subdomain", production_script_name: "pages-worker--1-production" },
        { name: "no-script", subdomain: "no-script.pages.dev" },
        { name: "fine", subdomain: "fine.pages.dev", production_script_name: "pages-worker--2-production" }
      ]
    });
    expect(projects).toEqual([{ name: "fine", subdomain: "fine.pages.dev", productionScriptName: "pages-worker--2-production" }]);
  });

  it("returns [] for every malformed envelope rather than throwing", () => {
    for (const bad of [null, undefined, 42, "nope", {}, { result: "nope" }]) {
      expect(normalizePagesProjects(bad)).toEqual([]);
    }
  });
});

describe("fetchPagesProjects", () => {
  it("throws on a non-2xx response", async () => {
    const stub: typeof fetch = async () => new Response("nope", { status: 403 });
    await expect(fetchPagesProjects("acc", "tok", stub)).rejects.toThrow(/403/);
  });

  it("throws on success:false instead of reporting an empty project list", async () => {
    const stub: typeof fetch = async () =>
      Response.json({ success: false, errors: [{ message: "Authentication error" }], result: null });
    await expect(fetchPagesProjects("acc", "tok", stub)).rejects.toThrow(/Authentication error/);
  });

  it("follows result_info.total_pages across multiple pages", async () => {
    const page1 = {
      success: true,
      result: [{ name: "a", subdomain: "a.pages.dev", production_script_name: "pages-worker--1-production" }],
      result_info: { page: 1, per_page: 1, count: 1, total_count: 2, total_pages: 2 }
    };
    const page2 = {
      success: true,
      result: [{ name: "b", subdomain: "b.pages.dev", production_script_name: "pages-worker--2-production" }],
      result_info: { page: 2, per_page: 1, count: 1, total_count: 2, total_pages: 2 }
    };
    const seenUrls: string[] = [];
    const stub: typeof fetch = async input => {
      const url = String(input);
      seenUrls.push(url);
      // Read the param properly rather than substring-matching "page=2".
      return Response.json(new URL(url).searchParams.get("page") === "2" ? page2 : page1);
    };
    const projects = await fetchPagesProjects("acc", "tok", stub);
    expect(projects.map(p => p.name)).toEqual(["a", "b"]);
    expect(seenUrls).toHaveLength(2);
    // Regression: the live Pages endpoint answers 400 to any request carrying
    // `per_page` (verified 2026-09-15 with curl: `?page=1` 200, `?per_page=25`
    // 400). The first deployed collector shipped with it and every run failed.
    for (const url of seenUrls) expect(new URL(url).searchParams.has("per_page")).toBe(false);
  });

  it("stops at a single page when total_pages is absent (defaults to 1)", async () => {
    const stub: typeof fetch = async () => Response.json({ success: true, result: [] });
    const projects = await fetchPagesProjects("acc", "tok", stub);
    expect(projects).toEqual([]);
  });
});

describe("resolvePagesFunctionsToWorkerDaily", () => {
  const projects = normalizePagesProjects(REAL_PROJECTS_SHAPE);

  it("resolves a matched scriptName to the project's pages.dev host, with subrequests: 0", () => {
    const rows = resolvePagesFunctionsToWorkerDaily(
      [{ scriptName: "pages-worker--18671371-production", date: "2026-09-08", requests: 7585, errors: 3 }],
      projects
    );
    expect(rows).toEqual([{ script: "yixi-app.pages.dev", date: "2026-09-08", requests: 7585, errors: 3, subrequests: 0 }]);
  });

  it("stores an unmatched scriptName under its raw id instead of dropping it", () => {
    // The mapping gap this guards against: a project id the Pages project
    // list call didn't return (renamed, deleted, or a pagination bug) must
    // still surface as a visibly odd row rather than silently vanishing.
    const rows = resolvePagesFunctionsToWorkerDaily(
      [{ scriptName: "pages-worker--99999999-production", date: "2026-09-08", requests: 42, errors: 0 }],
      projects
    );
    expect(rows).toEqual([{ script: "pages-worker--99999999-production", date: "2026-09-08", requests: 42, errors: 0, subrequests: 0 }]);
  });
});

describe("resolved rows in worker_daily storage", () => {
  it("upserts alongside an ordinary Worker's rows so both surface in the same totals list", async () => {
    const projects = normalizePagesProjects(REAL_PROJECTS_SHAPE);
    const pagesRows = resolvePagesFunctionsToWorkerDaily(
      [{ scriptName: "pages-worker--18671371-production", date: "2026-09-08", requests: 7585, errors: 0 }],
      projects
    );
    await upsertWorkerDaily(env.DB, [
      ...pagesRows,
      { script: "yixi", date: "2026-09-08", requests: 19, errors: 0, subrequests: 0 }
    ]);
    const totals = await getWorkerTotals(env.DB, 1, "2026-09-09");
    const scripts = totals.map(t => t.script).sort();
    expect(scripts).toEqual(["yixi", "yixi-app.pages.dev"]);
    expect(totals.find(t => t.script === "yixi-app.pages.dev")!.requests).toBe(7585);
  });
});
