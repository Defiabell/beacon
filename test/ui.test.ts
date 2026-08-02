import { describe, it, expect } from "vitest";
import { esc, svgSparkline, page } from "../src/ui/layout";
import { renderOverview, renderProject, renderMatrix, renderTodos, renderPosts } from "../src/ui/pages";
import type { Overview, ProjectDetail, MatrixData, PostWithMetrics, ProjectSummary } from "../src/api/public";
import type { Todo } from "../src/types";

describe("esc", () => {
  it("escapes a script tag so it can never be interpreted as markup", () => {
    expect(esc("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes ampersand and both quote characters", () => {
    expect(esc(`a & b "c" 'd'`)).toBe("a &amp; b &quot;c&quot; &#39;d&#39;");
  });

  it("passes plain text through unchanged", () => {
    expect(esc("nightide 夜潮")).toBe("nightide 夜潮");
  });
});

describe("svgSparkline", () => {
  it("returns an empty string for an empty series", () => {
    expect(svgSparkline([])).toBe("");
  });

  it("renders an <svg> with one point per input value", () => {
    const svg = svgSparkline([1, 5, 3, 9, 2]);
    expect(svg).toContain("<svg");
    const match = svg.match(/points="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1].trim().split(/\s+/)).toHaveLength(5);
  });

  it("renders a single point (not a visible line) for a one-value series, without dividing by zero", () => {
    const svg = svgSparkline([7]);
    expect(svg).toContain("<svg");
    const match = svg.match(/points="([^"]+)"/);
    expect(match![1].trim().split(/\s+/)).toHaveLength(1);
    expect(svg).not.toContain("NaN");
  });

  it("renders a flat line (not NaN) when every value is equal", () => {
    const svg = svgSparkline([4, 4, 4]);
    expect(svg).not.toContain("NaN");
    const match = svg.match(/points="([^"]+)"/);
    expect(match![1].trim().split(/\s+/)).toHaveLength(3);
  });
});

describe("page", () => {
  it("wraps the body in a full HTML document and escapes the title", () => {
    const html = page("<b>hi</b>", "<p>body content</p>");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).toContain("<p>body content</p>");
    expect(html).not.toContain("<title><b>");
  });
});

function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project: "nightide",
    repo: "Defiabell/nightide",
    stars: 10,
    starsDelta7d: 2,
    views14d: 50,
    clones14d: 5,
    postCount: 1,
    topReferrers: [],
    ...overrides
  };
}

describe("renderOverview", () => {
  it("contains every project name and the weekly-action-plan marker", () => {
    const overview: Overview = {
      projects: [summary(), summary({ project: "shotsync", repo: "Defiabell/shotsync" })],
      topTodos: [{ id: 1, project: "nightide", source: "audit", title: "fix readme link", priority: 1, status: "open" }],
      suggestions: [{ project: "shotsync", channelId: "v2ex", channelName: "V2EX", score: 3 }],
      sources: [{ source: "github", lastRunAt: "2026-08-01T01:00:00Z", ok: true, error: null }],
      sitePv7d: 100
    };
    const html = renderOverview(overview);
    expect(html).toContain("本周建议行动");
    expect(html).toContain("nightide");
    expect(html).toContain("shotsync");
    expect(html).toContain("fix readme link");
  });

  it("escapes a malicious todo title rather than injecting it raw", () => {
    const overview: Overview = {
      projects: [],
      topTodos: [{ id: 1, project: "nightide", source: "manual", title: "<script>alert(1)</script>", priority: 1, status: "open" }],
      suggestions: [],
      sources: [],
      sitePv7d: 0
    };
    const html = renderOverview(overview);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("doesn't crash on an all-empty Overview", () => {
    const overview: Overview = { projects: [], topTodos: [], suggestions: [], sources: [], sitePv7d: 0 };
    expect(() => renderOverview(overview)).not.toThrow();
  });
});

describe("renderProject", () => {
  const detail: ProjectDetail = {
    summary: summary(),
    repoSeries: [
      { repo: "Defiabell/nightide", date: "2026-07-30", views: 10, uniqueViews: 8, clones: 1, uniqueClones: 1, stars: 10, forks: 0 },
      { repo: "Defiabell/nightide", date: "2026-07-31", views: 20, uniqueViews: 15, clones: 2, uniqueClones: 2, stars: 11, forks: 0 }
    ],
    starSeries: [
      { date: "2026-07-30", stars: 10 },
      { date: "2026-07-31", stars: 11 }
    ],
    referrers: [{ referrer: "google.com", count: 5, uniques: 4 }],
    posts: [],
    audit: [
      { checkId: "description", status: "pass", detail: "description is 30 chars", priority: 1, checkedAt: "2026-08-01T00:00:00Z" },
      { checkId: "topics", status: "fail", detail: "0 topic(s)", priority: 1, checkedAt: "2026-08-01T00:00:00Z" },
      { checkId: "homepage", status: "na", detail: "no homepage configured for this project", priority: 3, checkedAt: "2026-08-01T00:00:00Z" }
    ]
  };

  it("renders every audit status (pass/fail/na) with its own class", () => {
    const html = renderProject("nightide", detail);
    expect(html).toContain('class="ok"');
    expect(html).toContain('class="bad"');
    expect(html).toContain('class="na"');
  });

  it("renders sparklines from the star and repo series", () => {
    const html = renderProject("nightide", detail);
    expect(html).toContain("<svg");
    expect(html).toContain("polyline");
  });

  it("escapes a malicious referrer value", () => {
    const withXss: ProjectDetail = {
      ...detail,
      referrers: [{ referrer: "<script>alert(1)</script>", count: 1, uniques: 1 }]
    };
    const html = renderProject("nightide", withXss);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("doesn't crash when every series/list is empty", () => {
    const empty: ProjectDetail = {
      summary: summary(),
      repoSeries: [],
      starSeries: [],
      referrers: [],
      posts: [],
      audit: []
    };
    expect(() => renderProject("nightide", empty)).not.toThrow();
  });
});

describe("renderMatrix", () => {
  it("renders posted (✓), planned (◷), na (—), and scored-suggestion cells", () => {
    const matrix: MatrixData = {
      projects: ["nightide"],
      channels: [
        { id: "v2ex", name: "V2EX", lang: "zh" },
        { id: "hn", name: "Show HN", lang: "en" },
        { id: "jike", name: "即刻", lang: "zh" }
      ],
      coverage: [
        { project: "nightide", channelId: "v2ex", status: "posted" },
        { project: "nightide", channelId: "jike", status: "planned" }
      ],
      suggestions: [{ project: "nightide", channelId: "hn", channelName: "Show HN", score: 2 }]
    };
    const html = renderMatrix(matrix);
    expect(html).toContain("nightide");
    expect(html).toContain('class="posted"');
    expect(html).toContain('class="planned"');
    expect(html).toContain('<span class="sug">2</span>');
  });
});

describe("renderTodos", () => {
  it("sorts open todos priority-ascending and lists done todos with their doneAt", () => {
    const todos: Todo[] = [
      { id: 1, project: "nightide", source: "audit", title: "p2 item", priority: 2, status: "open" },
      { id: 2, project: "nightide", source: "manual", title: "p1 item", priority: 1, status: "open" },
      { id: 3, project: "nightide", source: "manual", title: "finished item", priority: 1, status: "done", doneAt: "2026-08-01T00:00:00Z" }
    ];
    const html = renderTodos(todos);
    expect(html).toContain("p2 item");
    expect(html).toContain("p1 item");
    expect(html).toContain("finished item");
    expect(html).toContain("2026-08-01");
    // priority-ascending: "p1 item" must appear before "p2 item" in the open list
    expect(html.indexOf("p1 item")).toBeLessThan(html.indexOf("p2 item"));
  });

  it("escapes a malicious todo title", () => {
    const todos: Todo[] = [{ id: 1, project: "nightide", source: "manual", title: "<script>alert(1)</script>", priority: 1, status: "open" }];
    const html = renderTodos(todos);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("doesn't crash on an empty list", () => {
    expect(() => renderTodos([])).not.toThrow();
  });
});

describe("renderPosts", () => {
  it("renders titles, project, and platform chips", () => {
    const rows: PostWithMetrics[] = [
      {
        post: { id: 1, url: "https://www.v2ex.com/t/1", platform: "v2ex", project: "nightide", title: "夜潮发布", publishedAt: null },
        latest: { date: "2026-08-01", views: 100, replies: 5, likes: null, score: null }
      },
      {
        post: { id: 2, url: "https://news.ycombinator.com/item?id=1", platform: "hn", project: "shotsync", title: "Show HN: shotsync", publishedAt: null },
        latest: null
      }
    ];
    const html = renderPosts(rows);
    expect(html).toContain("夜潮发布");
    expect(html).toContain("nightide");
    expect(html).toContain("V2EX");
    expect(html).toContain("HN");
  });

  it("escapes a malicious post title", () => {
    const rows: PostWithMetrics[] = [
      {
        post: { id: 1, url: "https://example.com", platform: "v2ex", project: "nightide", title: "<script>alert(1)</script>", publishedAt: null },
        latest: null
      }
    ];
    const html = renderPosts(rows);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("doesn't crash on an empty list", () => {
    expect(() => renderPosts([])).not.toThrow();
  });
});
