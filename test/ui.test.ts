import { describe, it, expect } from "vitest";
import { esc, svgSparkline, page } from "../src/ui/layout";
import { renderOverview, renderProject, renderMatrix, renderTodos, renderPosts, renderLogin, renderImpact } from "../src/ui/pages";
import type { Overview, ProjectDetail, MatrixData, PostWithMetrics, ProjectSummary } from "../src/api/public";
import type { Todo } from "../src/types";
import type { EventImpact } from "../src/impact/attribute";
import { CONFIG } from "../src/config";

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

  it("with no markers argument, renders exactly as before this feature (no marker lines)", () => {
    const svg = svgSparkline([1, 2, 3]);
    expect(svg).not.toContain('class="marker"');
  });

  it("draws one vertical marker line per in-range marker, carrying its escaped label as a <title> tooltip", () => {
    const svg = svgSparkline([1, 2, 3, 4, 5], 100, 40, [{ index: 2, label: "<b>发帖</b>" }]);
    expect(svg).toContain('class="marker"');
    expect(svg).not.toContain("<b>发帖</b>");
    expect(svg).toContain("&lt;b&gt;发帖&lt;/b&gt;");
    // exactly one marker line for the one in-range marker given
    expect((svg.match(/class="marker"/g) ?? []).length).toBe(1);
  });

  it("silently drops a marker whose index falls outside the series (event date not present in this particular series)", () => {
    const svg = svgSparkline([1, 2, 3], 100, 40, [{ index: 99, label: "out of range" }, { index: -1, label: "also out of range" }]);
    expect(svg).not.toContain('class="marker"');
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
    machineClones14d: 0,
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
    const html = renderOverview(overview, false);
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
    const html = renderOverview(overview, false);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("doesn't crash on an all-empty Overview", () => {
    const overview: Overview = { projects: [], topTodos: [], suggestions: [], sources: [], sitePv7d: 0 };
    expect(() => renderOverview(overview, false)).not.toThrow();
  });

  // Review item 1 (design doc §3): machineClones14d has no display surface
  // anywhere — a project's "clones 14d" chip silently included bot/CI clones
  // with no disclosure at all.
  describe("machine-clone disclosure on the project card", () => {
    it("discloses machineClones14d alongside the human clone count when it's nonzero", () => {
      const overview: Overview = {
        projects: [summary({ project: "nightide", clones14d: 2, machineClones14d: 109 })],
        topTodos: [],
        suggestions: [],
        sources: [],
        sitePv7d: 0
      };
      const html = renderOverview(overview, false);
      expect(html).toContain("clones 14d 2");
      expect(html).toContain("109");
      expect(html).toContain("机器");
    });

    it("adds no machine-clone note when machineClones14d is 0", () => {
      const overview: Overview = {
        projects: [summary({ project: "nightide", clones14d: 5, machineClones14d: 0 })],
        topTodos: [],
        suggestions: [],
        sources: [],
        sitePv7d: 0
      };
      const html = renderOverview(overview, false);
      expect(html).not.toContain("机器");
    });
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
    const html = renderProject("nightide", detail, false);
    expect(html).toContain('class="ok"');
    expect(html).toContain('class="bad"');
    expect(html).toContain('class="na"');
  });

  it("renders sparklines from the star and repo series", () => {
    const html = renderProject("nightide", detail, false);
    expect(html).toContain("<svg");
    expect(html).toContain("polyline");
  });

  it("omits the detail chip entirely when a check has no detail", () => {
    const noDetail: ProjectDetail = {
      ...detail,
      audit: [
        { checkId: "license", status: "pass", detail: "", priority: 2, checkedAt: "2026-08-01T00:00:00Z" },
        { checkId: "topics", status: "fail", detail: "0 topic(s)", priority: 1, checkedAt: "2026-08-01T00:00:00Z" }
      ]
    };
    const html = renderProject("nightide", noDetail, false);
    // .chip is a bordered pill: an empty one would render as visible noise next to every passing check.
    expect(html).not.toContain('<span class="chip"></span>');
    expect(html).toContain('<span class="chip">0 topic(s)</span>');
  });

  it("escapes a malicious referrer value", () => {
    const withXss: ProjectDetail = {
      ...detail,
      referrers: [{ referrer: "<script>alert(1)</script>", count: 1, uniques: 1 }]
    };
    const html = renderProject("nightide", withXss, false);
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
    expect(() => renderProject("nightide", empty, false)).not.toThrow();
  });

  // Review item 1: same disclosure requirement as the overview card, applied
  // to the project detail page's own clone figures.
  describe("machine-clone disclosure on the clone-count card", () => {
    it("shows the machine clone count next to the human clones · 14d figure when nonzero", () => {
      const withMachine: ProjectDetail = { ...detail, summary: summary({ clones14d: 2, machineClones14d: 109 }) };
      const html = renderProject("nightide", withMachine, false);
      expect(html).toContain("109");
      expect(html).toContain("机器");
    });

    it("adds no machine-clone note when machineClones14d is 0", () => {
      const html = renderProject("nightide", detail, false); // detail's summary() defaults machineClones14d to 0
      expect(html).not.toContain("机器");
    });
  });

  describe("event markers on the curves (design doc §5)", () => {
    it("with no events field at all (pre-feature ProjectDetail shape), renders no marker lines", () => {
      const html = renderProject("nightide", detail, false);
      expect(html).not.toContain('class="marker"');
    });

    it("an event whose date matches a repoSeries/starSeries date draws a marker, with an escaped label tooltip", () => {
      const withEvent: ProjectDetail = {
        ...detail,
        events: [
          {
            event: { kind: "post", date: "2026-07-31", project: "nightide", title: "<b>发帖</b>", platform: "v2ex", url: "https://x" },
            before: { days: 7, views: 10, humanClones: 0, starsDelta: 0 },
            after: { days: 7, views: 20, humanClones: 0, starsDelta: 1 },
            status: "complete"
          }
        ]
      };
      const html = renderProject("nightide", withEvent, false);
      expect(html).toContain('class="marker"');
      expect(html).not.toContain("<b>发帖</b>");
      expect(html).toContain("&lt;b&gt;发帖&lt;/b&gt;");
    });

    it("an event whose date isn't present in either series draws no marker, without crashing", () => {
      const withOutOfRangeEvent: ProjectDetail = {
        ...detail,
        events: [
          {
            event: { kind: "todo", date: "2020-01-01", project: "nightide", title: "太久以前" },
            before: { days: 0, views: 0, humanClones: 0, starsDelta: 0 },
            after: { days: 0, views: 0, humanClones: 0, starsDelta: 0 },
            status: "collecting"
          }
        ]
      };
      expect(() => renderProject("nightide", withOutOfRangeEvent, false)).not.toThrow();
      expect(renderProject("nightide", withOutOfRangeEvent, false)).not.toContain('class="marker"');
    });
  });
});

describe("renderMatrix", () => {
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

  it("renders posted (✓), planned (◷), na (—), and scored-suggestion cells", () => {
    const html = renderMatrix(matrix, false);
    expect(html).toContain("nightide");
    expect(html).toContain('class="posted"');
    expect(html).toContain('class="planned"');
    expect(html).toContain('<span class="sug">2</span>');
  });

  it("authed=false never emits a cell form (read-only, unchanged from before this feature)", () => {
    const html = renderMatrix(matrix, false);
    // Checks for the actual rendered <form action="..."> element, not a bare
    // "<form" substring — src/ui/layout.ts's shared CSS legitimately contains
    // the literal text "<form>" inside an explanatory comment (present on
    // every page regardless of auth state), so that substring alone isn't a
    // reliable signal.
    expect(html).not.toContain('action="/ui/channel"');
  });

  it("authed=true replaces every cell with a form posting to /ui/channel, carrying the project/channelId hidden fields", () => {
    const html = renderMatrix(matrix, true);
    const formCount = (html.match(/action="\/ui\/channel"/g) ?? []).length;
    expect(formCount).toBe(matrix.projects.length * matrix.channels.length);
    expect(html).toContain('<input type="hidden" name="project" value="nightide">');
    expect(html).toContain('<input type="hidden" name="channelId" value="v2ex">');
    expect(html).toContain('<input type="hidden" name="returnTo" value="/matrix">');
  });

  it("authed=true pre-selects the cell's current status in its <select>", () => {
    const html = renderMatrix(matrix, true);
    // the v2ex cell is "posted" — its <option value="posted"> must carry `selected`
    const v2exCellMatch = html.match(/aria-label="nightide × V2EX"[^]*?<\/select>/);
    expect(v2exCellMatch).not.toBeNull();
    expect(v2exCellMatch![0]).toContain('<option value="posted" selected>');
  });

  it("authed=true gives an uncovered cell a disabled placeholder carrying its suggestion score, with nothing pre-selected among the real options", () => {
    const html = renderMatrix(matrix, true);
    const hnCellMatch = html.match(/aria-label="nightide × Show HN"[^]*?<\/select>/);
    expect(hnCellMatch).not.toBeNull();
    expect(hnCellMatch![0]).toContain('<option value="" selected disabled>建议 2</option>');
  });

  // Review item 2 (design doc §5): buildMatrix already computes coverage[].effect
  // (a MatrixEffect) and /api/matrix exposes it, but renderMatrix's covByKey
  // only ever carried `status` — a posted cell rendered a bare ✓ no matter what
  // buildMatrix paid ~10 extra D1 queries to compute. "the test whose absence
  // hid this" per the review note.
  describe("posted cell effect (design doc §5 / review item 2)", () => {
    const matrixWithEffect: MatrixData = {
      projects: ["nightide"],
      channels: [{ id: "v2ex", name: "V2EX", lang: "zh" }],
      coverage: [
        {
          project: "nightide",
          channelId: "v2ex",
          status: "posted",
          effect: { views: 29, humanClones: 2, starsDelta: 2, status: "complete", days: 7 }
        }
      ],
      suggestions: []
    };

    // Scoped to <tbody> (not the whole document): src/ui/layout.ts's shared
    // CSS carries both the literal Chinese text "统计中" (an explanatory
    // comment) and the class name "win-note" (its own selector) on every page
    // regardless of content — a whole-document substring check on either would
    // pass whether or not renderMatrix does anything at all.
    function tbody(html: string): string {
      return html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? "";
    }

    it("a posted cell with an attached effect renders its actual numbers, not a bare checkmark", () => {
      const html = renderMatrix(matrixWithEffect, false);
      const body = tbody(html);
      expect(body).toContain("✓");
      expect(body).toContain("29");
    });

    it("a posted cell whose effect is still collecting carries the same honesty caveat used everywhere else", () => {
      const collectingMatrix: MatrixData = {
        ...matrixWithEffect,
        coverage: [
          {
            project: "nightide",
            channelId: "v2ex",
            status: "posted",
            effect: { views: 5, humanClones: 0, starsDelta: 0, status: "collecting", days: 2 }
          }
        ]
      };
      const body = tbody(renderMatrix(collectingMatrix, false));
      expect(body).toContain('class="win-note"');
      expect(body).toContain("统计中");
    });

    it("a posted cell with no effect (no postId link) still renders the plain checkmark, unchanged", () => {
      const body = tbody(renderMatrix(matrix, false)); // matrix's v2ex coverage row carries no `effect`
      expect(body).toContain('class="posted"');
      expect(body).not.toContain('class="win-note"');
    });
  });
});

describe("renderTodos", () => {
  it("sorts open todos priority-ascending and lists done todos with their doneAt", () => {
    const todos: Todo[] = [
      { id: 1, project: "nightide", source: "audit", title: "p2 item", priority: 2, status: "open" },
      { id: 2, project: "nightide", source: "manual", title: "p1 item", priority: 1, status: "open" },
      { id: 3, project: "nightide", source: "manual", title: "finished item", priority: 1, status: "done", doneAt: "2026-08-01T00:00:00Z" }
    ];
    const html = renderTodos(todos, false);
    expect(html).toContain("p2 item");
    expect(html).toContain("p1 item");
    expect(html).toContain("finished item");
    expect(html).toContain("2026-08-01");
    // priority-ascending: "p1 item" must appear before "p2 item" in the open list
    expect(html.indexOf("p1 item")).toBeLessThan(html.indexOf("p2 item"));
  });

  it("escapes a malicious todo title", () => {
    const todos: Todo[] = [{ id: 1, project: "nightide", source: "manual", title: "<script>alert(1)</script>", priority: 1, status: "open" }];
    const html = renderTodos(todos, false);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("doesn't crash on an empty list", () => {
    expect(() => renderTodos([], false)).not.toThrow();
  });

  // M1: the shared CSS (src/ui/layout.ts) defines `ul.plain` styling, but
  // renderTodos used to emit bare `<ul>` for both the open and done lists,
  // leaving them unstyled.
  it("renders both the open and done lists with class=\"plain\"", () => {
    const todos: Todo[] = [
      { id: 1, project: "nightide", source: "audit", title: "open item", priority: 1, status: "open" },
      { id: 2, project: "nightide", source: "manual", title: "done item", priority: 1, status: "done", doneAt: "2026-08-01T00:00:00Z" }
    ];
    const html = renderTodos(todos, false);
    const matches = html.match(/<ul class="plain"/g) ?? [];
    expect(matches.length).toBe(2);
  });

  describe("authed=true", () => {
    const todos: Todo[] = [
      { id: 11, project: "nightide", source: "audit", title: "open item", priority: 1, status: "open" },
      { id: 22, project: "nightide", source: "manual", title: "done item", priority: 1, status: "done", doneAt: "2026-08-01T00:00:00Z" }
    ];

    it("gives every todo a real (non-disabled) checkbox inside a form posting to /ui/todo", () => {
      const html = renderTodos(todos, true);
      // Checks for the exact anonymous-rendering checkbox markup, not a bare
      // "disabled" substring — src/ui/layout.ts's shared CSS legitimately
      // mentions "disabled" in an explanatory comment (present on every page
      // regardless of auth state).
      expect(html).not.toContain('<input type="checkbox" disabled>');
      expect(html).not.toContain('<input type="checkbox" checked disabled>');
      expect((html.match(/action="\/ui\/todo"/g) ?? []).length).toBe(2);
      expect(html).toContain('<input type="hidden" name="id" value="11">');
      expect(html).toContain('<input type="hidden" name="id" value="22">');
    });

    it("the open item's checkbox is unchecked and the done item's is checked", () => {
      const html = renderTodos(todos, true);
      const openLi = html.slice(html.indexOf('value="11"'), html.indexOf('value="11"') + 200);
      expect(openLi).not.toContain("checked");
      const doneLi = html.slice(html.indexOf('value="22"'), html.indexOf('value="22"') + 200);
      expect(doneLi).toContain("checked");
    });

    it("authed=false never emits a form for a todo (read-only, unchanged from before this feature)", () => {
      const html = renderTodos(todos, false);
      expect(html).not.toContain('action="/ui/todo"');
    });
  });

  describe("filter", () => {
    const todos: Todo[] = [
      { id: 1, project: "nightide", source: "audit", title: "open item", priority: 1, status: "open" },
      { id: 2, project: "nightide", source: "manual", title: "done item", priority: 1, status: "done", doneAt: "2026-08-01T00:00:00Z" }
    ];

    it("default (no filter) shows both sections, and the 进行中 pill is marked active", () => {
      const html = renderTodos(todos, false);
      expect(html).toContain("open item");
      expect(html).toContain("done item");
      expect(html).toMatch(/<a class="filter on" href="\/todos">进行中 1<\/a>/);
    });

    it('filter="done" hides the open section entirely and marks the 已完成 pill active', () => {
      const html = renderTodos(todos, false, "done");
      expect(html).not.toContain("open item");
      expect(html).toContain("done item");
      expect(html).not.toContain("进行中</p>"); // the section caption itself is gone, not just its items
      expect(html).toMatch(/<a class="filter on" href="\/todos\?status=done">已完成 1<\/a>/);
    });

    it("the filter pills are real links to /todos and /todos?status=done", () => {
      const html = renderTodos(todos, false);
      expect(html).toContain('href="/todos"');
      expect(html).toContain('href="/todos?status=done"');
    });

    it('when authed and filtered to done, each done item\'s returnTo reflects the current filtered view', () => {
      const html = renderTodos(todos, true, "done");
      expect(html).toContain('<input type="hidden" name="returnTo" value="/todos?status=done">');
    });
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
    const html = renderPosts(rows, false);
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
    const html = renderPosts(rows, false);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("doesn't crash on an empty list", () => {
    expect(() => renderPosts([], false)).not.toThrow();
  });

  describe("authed=true: add-post form", () => {
    it("renders a collapsible ＋登记帖子 form posting to /ui/post, with every configured project as an option", () => {
      const html = renderPosts([], true);
      expect(html).toContain("<details");
      expect(html).toContain("＋ 登记帖子");
      expect(html).toContain('<form method="post" action="/ui/post"');
      for (const p of CONFIG.projects) {
        expect(html).toContain(`<option value="${p.name}">${p.name}</option>`);
      }
    });

    it("authed=false never renders the add-post form", () => {
      const html = renderPosts([], false);
      expect(html).not.toContain("/ui/post");
      expect(html).not.toContain("＋ 登记帖子");
    });
  });
});

// ---- renderImpact -----------------------------------------------------------

function impact(over: Partial<EventImpact> = {}): EventImpact {
  return {
    event: { kind: "post", date: "2026-08-09", project: "shotsync", title: "shotsync 分享创造", platform: "v2ex", url: "https://www.v2ex.com/t/1229945" },
    before: { days: 7, views: 21, humanClones: 1, starsDelta: 0 },
    after: { days: 7, views: 60, humanClones: 3, starsDelta: 2 },
    status: "complete",
    ...over
  };
}

// Rows must be extracted from the impact list itself: a bare /<li>...<\/li>/
// against the whole document matches the "<li>" that appears inside layout.ts's
// CSS comment first, silently widening the "row" to include the stylesheet and
// header — which would let the honesty assertions below pass on text that isn't
// in the row at all.
function impactRows(html: string): string[] {
  const list = html.match(/<ol class="impact">[\s\S]*?<\/ol>/);
  if (!list) return [];
  return list[0].match(/<li>[\s\S]*?<\/li>/g) ?? [];
}

describe("renderImpact", () => {
  it("lists an event with its project, action, and before/after numbers", () => {
    const html = renderImpact([impact()], false);
    expect(html).toContain("shotsync");
    expect(html).toContain("shotsync 分享创造");
    expect(html).toContain("2026-08-09");
    expect(html).toContain("21");
    expect(html).toContain("60");
  });

  it("doesn't crash on an empty list, and shows a placeholder", () => {
    expect(() => renderImpact([], false)).not.toThrow();
    expect(renderImpact([], false)).toContain("暂无事件");
  });

  it("escapes a malicious event title rather than injecting it raw", () => {
    const html = renderImpact([impact({ event: { ...impact().event, title: "<script>alert(1)</script>" } })], false);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  // The honesty rule (design doc §4/§7, the thing most likely to be got
  // wrong): an incomplete after-window must never read as a confirmed,
  // final zero. Structurally, this means the row's "collecting" caveat and
  // its day count must sit in the same list item as the numbers themselves —
  // not just be present somewhere on the page.
  describe("honesty rule: collecting status", () => {
    it("a collecting after-window shows its actual (possibly 0) numbers, but never without the collecting caveat + day count in the same row", () => {
      const collecting = impact({
        after: { days: 1, views: 0, humanClones: 0, starsDelta: 0 },
        status: "collecting"
      });
      const html = renderImpact([collecting], false);
      const li = impactRows(html)[0];
      expect(li).toContain("统计中");
      expect(li).toContain("1"); // the day count, "已有 1/7 天" or equivalent
      expect(li).toContain("7");
    });

    it("never claims a plain 'no effect'/'0 impact' conclusion phrase for a collecting row", () => {
      const collecting = impact({ after: { days: 2, views: 0, humanClones: 0, starsDelta: 0 }, status: "collecting" });
      const html = renderImpact([collecting], false);
      expect(html).not.toContain("无效果");
      expect(html).not.toContain("没有效果");
    });
  });

  it("an insufficient-history row is still shown (not hidden) but is visually distinct from a complete one", () => {
    const insufficient = impact({ before: { days: 2, views: 5, humanClones: 0, starsDelta: 0 }, status: "insufficient-history" });
    const html = renderImpact([insufficient], false);
    expect(html).toContain("shotsync");
    expect(html).not.toContain('class="ok"'); // not rendered as a confident "complete" conclusion
  });

  it("links a post event's title to its URL; a todo event has no link", () => {
    const html = renderImpact([impact()], false);
    expect(html).toContain('href="https://www.v2ex.com/t/1229945"');

    const todoImpact = impact({ event: { kind: "todo", date: "2026-08-01", project: "nightide", title: "补 topics" } });
    const todoHtml = renderImpact([todoImpact], false);
    expect(todoHtml).toContain("补 topics");
    // Scoped to the row, not the document: the page always carries nav and
    // login <a> elements, so asserting on the whole HTML would be testing the
    // header rather than the claim ("a todo event has no link").
    // The claim is about the *title*: a post links out to where it was
    // published, a todo has nowhere to go. Asserting "no <a> anywhere in the
    // row" would also forbid the project chip's link to /p/:project, which is
    // useful navigation and has nothing to do with this behaviour.
    const todoTitle = impactRows(todoHtml)[0].match(/<span class="ev-title[^"]*">[\s\S]*?<\/span>/)![0];
    expect(todoTitle).not.toContain("<a");
    const postTitle = impactRows(html)[0].match(/<span class="ev-title[^"]*">[\s\S]*?<\/span>/)![0];
    expect(postTitle).toContain('href="https://www.v2ex.com/t/1229945"');
  });

  it("carries the login/logout header link like every other page", () => {
    expect(renderImpact([], false)).toContain('<a href="/login">登录</a>');
    expect(renderImpact([], true)).toContain("登出");
  });
});

describe("header login/logout link (navHeader)", () => {
  it("renderOverview shows a 登录 link when logged out", () => {
    const html = renderOverview({ projects: [], topTodos: [], suggestions: [], sources: [], sitePv7d: 0 }, false);
    expect(html).toContain('<a href="/login">登录</a>');
    expect(html).not.toContain("登出");
  });

  it("renderOverview shows a 登出 form (not a link) when logged in", () => {
    const html = renderOverview({ projects: [], topTodos: [], suggestions: [], sources: [], sitePv7d: 0 }, true);
    expect(html).toContain('<form method="post" action="/logout"');
    expect(html).toContain("登出");
    expect(html).not.toContain('href="/login"');
  });

  it("every one of the four nav pages threads the same header link (matrix/todos/posts too)", () => {
    const matrix: MatrixData = { projects: [], channels: [], coverage: [], suggestions: [] };
    expect(renderMatrix(matrix, true)).toContain("登出");
    expect(renderTodos([], true)).toContain("登出");
    expect(renderPosts([], true)).toContain("登出");
  });

  it("renderProject also carries the login/logout link in its simplified header", () => {
    const detail: ProjectDetail = {
      summary: summary(),
      repoSeries: [],
      starSeries: [],
      referrers: [],
      posts: [],
      audit: []
    };
    expect(renderProject("nightide", detail, false)).toContain('<a href="/login">登录</a>');
    expect(renderProject("nightide", detail, true)).toContain("登出");
  });
});

describe("renderLogin", () => {
  it("renders the password form with no error text", () => {
    const html = renderLogin(false);
    expect(html).toContain('<form method="post" action="/login"');
    expect(html).toContain('type="password"');
    // Checks for the actual rendered <p class="error-text"> element, not a
    // bare "error-text" substring — src/ui/layout.ts's shared CSS always
    // defines the .error-text *rule* (present on every page regardless of
    // whether this page uses it), so that substring alone isn't reliable.
    expect(html).not.toContain('<p class="error-text">');
  });

  it("renders the error message when error=true", () => {
    const html = renderLogin(true);
    expect(html).toContain('class="error-text"');
    expect(html).toContain("令牌错误");
  });
});
