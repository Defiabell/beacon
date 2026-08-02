import { describe, it, expect } from "vitest";
import { detectPlatform, fetchPostMetrics } from "../src/collect/posts";
import type { Platform } from "../src/types";
import v2exFixture from "./fixtures/v2ex-topic.json";
import linuxdoFixture from "./fixtures/linuxdo-topic.json";
import hnFixture from "./fixtures/hn-item.json";
import redditFixture from "./fixtures/reddit-post.json";

describe("detectPlatform", () => {
  it("detects v2ex from hostname", () => {
    expect(detectPlatform("https://www.v2ex.com/t/1229945#reply2")).toBe("v2ex");
  });
  it("detects linuxdo from hostname", () => {
    expect(detectPlatform("https://linux.do/t/example-topic/12345")).toBe("linuxdo");
  });
  it("detects hn from hostname", () => {
    expect(detectPlatform("https://news.ycombinator.com/item?id=39912345")).toBe("hn");
  });
  it("detects reddit from hostname", () => {
    expect(
      detectPlatform("https://www.reddit.com/r/programming/comments/abc123/example_reddit_post/")
    ).toBe("reddit");
  });
  it("returns null for an unknown domain", () => {
    expect(detectPlatform("https://example.com/whatever")).toBeNull();
  });
  it("returns null for an unparsable url", () => {
    expect(detectPlatform("not a url")).toBeNull();
  });
});

describe("fetchPostMetrics: v2ex", () => {
  it("maps replies from [0].replies and nulls out unmapped fields", async () => {
    const stub: typeof fetch = async () => Response.json(v2exFixture);
    const m = await fetchPostMetrics("https://www.v2ex.com/t/1229945#reply2", "v2ex", stub);
    expect(m.replies).toBe(v2exFixture[0].replies);
    expect(m.views).toBeNull();
    expect(m.likes).toBeNull();
    expect(m.score).toBeNull();
  });

  it("requests the topics/show.json endpoint with the id extracted from the pathname", async () => {
    let requested = "";
    const stub: typeof fetch = async input => {
      requested = String(input);
      return Response.json(v2exFixture);
    };
    await fetchPostMetrics("https://www.v2ex.com/t/1229945#reply2", "v2ex", stub);
    expect(requested).toBe("https://www.v2ex.com/api/topics/show.json?id=1229945");
  });

  it("throws when the id cannot be extracted from the pathname", async () => {
    const stub: typeof fetch = async () => Response.json(v2exFixture);
    await expect(
      fetchPostMetrics("https://www.v2ex.com/t/not-a-number", "v2ex", stub)
    ).rejects.toThrow();
  });
});

describe("fetchPostMetrics: linuxdo", () => {
  it("maps views/likes directly and derives replies from posts_count - 1", async () => {
    const stub: typeof fetch = async () => Response.json(linuxdoFixture);
    const m = await fetchPostMetrics("https://linux.do/t/example-topic/12345", "linuxdo", stub);
    expect(m.views).toBe(linuxdoFixture.views);
    expect(m.likes).toBe(linuxdoFixture.like_count);
    expect(m.replies).toBe(linuxdoFixture.posts_count - 1);
    expect(m.score).toBeNull();
  });

  it("requests the t/<id>.json endpoint with the id extracted from the pathname", async () => {
    let requested = "";
    const stub: typeof fetch = async input => {
      requested = String(input);
      return Response.json(linuxdoFixture);
    };
    await fetchPostMetrics("https://linux.do/t/example-topic/12345", "linuxdo", stub);
    expect(requested).toBe("https://linux.do/t/12345.json");
  });
});

describe("fetchPostMetrics: hn", () => {
  it("maps score and descendants, nulls out views/likes", async () => {
    const stub: typeof fetch = async () => Response.json(hnFixture);
    const m = await fetchPostMetrics("https://news.ycombinator.com/item?id=39912345", "hn", stub);
    expect(m.score).toBe(hnFixture.score);
    expect(m.replies).toBe(hnFixture.descendants);
    expect(m.views).toBeNull();
    expect(m.likes).toBeNull();
  });

  it("throws when the id query param is missing", async () => {
    const stub: typeof fetch = async () => Response.json(hnFixture);
    await expect(
      fetchPostMetrics("https://news.ycombinator.com/item", "hn", stub)
    ).rejects.toThrow();
  });
});

describe("fetchPostMetrics: reddit", () => {
  it("maps score and num_comments from the nested listing shape", async () => {
    const stub: typeof fetch = async () => Response.json(redditFixture);
    const m = await fetchPostMetrics(
      "https://www.reddit.com/r/programming/comments/abc123/example_reddit_post/",
      "reddit",
      stub
    );
    const expected = redditFixture[0].data.children[0].data;
    expect(m.score).toBe(expected.score);
    expect(m.replies).toBe(expected.num_comments);
    expect(m.views).toBeNull();
    expect(m.likes).toBeNull();
  });

  it("appends .json to the permalink", async () => {
    let requested = "";
    const stub: typeof fetch = async input => {
      requested = String(input);
      return Response.json(redditFixture);
    };
    await fetchPostMetrics(
      "https://www.reddit.com/r/programming/comments/abc123/example_reddit_post/",
      "reddit",
      stub
    );
    expect(requested).toBe(
      "https://www.reddit.com/r/programming/comments/abc123/example_reddit_post.json"
    );
  });
});

describe("fetchPostMetrics: shared behavior", () => {
  it("sends a User-Agent header on every platform request", async () => {
    const cases: [string, "v2ex" | "linuxdo" | "hn" | "reddit", unknown][] = [
      ["https://www.v2ex.com/t/1229945", "v2ex", v2exFixture],
      ["https://linux.do/t/example-topic/12345", "linuxdo", linuxdoFixture],
      ["https://news.ycombinator.com/item?id=39912345", "hn", hnFixture],
      [
        "https://www.reddit.com/r/programming/comments/abc123/example_reddit_post/",
        "reddit",
        redditFixture
      ]
    ];
    for (const [url, platform, fixture] of cases) {
      let capturedHeaders: HeadersInit | undefined;
      const stub: typeof fetch = async (_input, init) => {
        capturedHeaders = init?.headers;
        return Response.json(fixture);
      };
      await fetchPostMetrics(url, platform, stub);
      expect(new Headers(capturedHeaders).get("User-Agent")).toBe(
        "beacon (+https://github.com/Defiabell/beacon)"
      );
    }
  });

  it("throws with the status code on a non-2xx upstream response", async () => {
    const bad: typeof fetch = async () => new Response("nope", { status: 500 });
    await expect(
      fetchPostMetrics("https://www.v2ex.com/t/1229945", "v2ex", bad)
    ).rejects.toThrow(/500/);
  });

  it("throws for an unknown/malformed platform value instead of resolving undefined", async () => {
    const stub: typeof fetch = async () => Response.json(v2exFixture);
    await expect(
      fetchPostMetrics("https://www.v2ex.com/t/1229945", "bogus" as Platform, stub)
    ).rejects.toThrow(/unknown platform/);
  });
});
