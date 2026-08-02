import { describe, it, expect } from "vitest";
import { fetchRepoTraffic } from "../src/collect/github";
import views from "./fixtures/gh-views.json";
import clones from "./fixtures/gh-clones.json";
import referrers from "./fixtures/gh-referrers.json";
import repoMeta from "./fixtures/gh-repo.json";

const stub: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/traffic/views")) return Response.json(views);
  if (url.endsWith("/traffic/clones")) return Response.json(clones);
  if (url.endsWith("/traffic/popular/referrers")) return Response.json(referrers);
  if (url.includes("/repos/")) return Response.json(repoMeta);
  return new Response("not found", { status: 404 });
};

describe("fetchRepoTraffic", () => {
  it("merges views+clones by date and attaches stars/forks", async () => {
    const t = await fetchRepoTraffic("tok", "Defiabell/shotsync", stub);
    const d = t.daily.find(r => r.date === "2026-08-01")!;
    expect(d.views).toBe(views.views.find((v: { timestamp: string }) => v.timestamp.startsWith("2026-08-01"))!.count);
    expect(d.clones).toBeGreaterThanOrEqual(0);
    expect(d.stars).toBe(repoMeta.stargazers_count);
    expect(t.referrers.length).toBe(referrers.length);
  });
  it("throws on non-2xx", async () => {
    const bad: typeof fetch = async () => new Response("nope", { status: 403 });
    await expect(fetchRepoTraffic("tok", "o/r", bad)).rejects.toThrow(/403/);
  });
});
