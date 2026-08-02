import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("scaffold", () => {
  it("has a D1 binding", async () => {
    const r = await env.DB.prepare("select 1 as one").first<{ one: number }>();
    expect(r?.one).toBe(1);
  });
});
