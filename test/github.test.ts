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
    const viewDay = views.views.find((v: { timestamp: string }) => v.timestamp.startsWith("2026-08-01"))!;
    const cloneDay = clones.clones.find((c: { timestamp: string }) => c.timestamp.startsWith("2026-08-01"))!;
    expect(d.views).toBe(viewDay.count);
    expect(d.uniqueViews).toBe(viewDay.uniques);
    expect(d.clones).toBe(cloneDay.count);
    expect(d.uniqueClones).toBe(cloneDay.uniques);
    expect(d.stars).toBe(repoMeta.stargazers_count);
    expect(d.forks).toBe(repoMeta.forks_count);
    expect(t.referrers.length).toBe(referrers.length);
  });
  it("fills the non-overlapping metric with 0 on a views-only date, still attaching stars/forks", async () => {
    const t = await fetchRepoTraffic("tok", "Defiabell/shotsync", stub);
    const d = t.daily.find(r => r.date === "2026-07-30")!;
    const viewDay = views.views.find((v: { timestamp: string }) => v.timestamp.startsWith("2026-07-30"))!;
    expect(clones.clones.some((c: { timestamp: string }) => c.timestamp.startsWith("2026-07-30"))).toBe(false);
    expect(d.views).toBe(viewDay.count);
    expect(d.uniqueViews).toBe(viewDay.uniques);
    expect(d.clones).toBe(0);
    expect(d.uniqueClones).toBe(0);
    expect(d.stars).toBe(repoMeta.stargazers_count);
    expect(d.forks).toBe(repoMeta.forks_count);
  });
  it("throws on non-2xx", async () => {
    const bad: typeof fetch = async () => new Response("nope", { status: 403 });
    await expect(fetchRepoTraffic("tok", "o/r", bad)).rejects.toThrow(/403/);
  });
});
