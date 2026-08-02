import { describe, it, expect } from "vitest";
import { backfillStarHistory } from "../src/collect/github";

const page1 = [
  { starred_at: "2026-07-01T10:00:00Z", user: { login: "a" } },
  { starred_at: "2026-07-01T11:00:00Z", user: { login: "b" } }
];
const page2 = [
  { starred_at: "2026-07-03T09:00:00Z", user: { login: "c" } },
  { starred_at: "2026-07-03T12:00:00Z", user: { login: "d" } }
];

describe("backfillStarHistory", () => {
  it("paginates via Link rel=next and returns cumulative stars ascending by date", async () => {
    const seenAccept: string[] = [];
    const stub: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      seenAccept.push(headers.get("Accept") ?? "");
      const page = url.searchParams.get("page");
      if (page === "1") {
        return new Response(JSON.stringify(page1), {
          status: 200,
          headers: { Link: '<https://api.github.com/repos/o/r/stargazers?per_page=100&page=2>; rel="next"' }
        });
      }
      if (page === "2") {
        return new Response(JSON.stringify(page2), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await backfillStarHistory("tok", "o/r", stub);

    expect(result).toEqual([
      { date: "2026-07-01", stars: 2 },
      { date: "2026-07-03", stars: 4 }
    ]);
    expect(seenAccept.every(a => a === "application/vnd.github.star+json")).toBe(true);
    expect(seenAccept.length).toBe(2);
  });

  it("throws on non-2xx", async () => {
    const bad: typeof fetch = async () => new Response("nope", { status: 403 });
    await expect(backfillStarHistory("tok", "o/r", bad)).rejects.toThrow(/403/);
  });
});
