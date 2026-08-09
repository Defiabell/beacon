import { describe, it, expect } from "vitest";
import { parseForm, formString, safeRedirectPath } from "../src/http-forms";

function formRequest(body: string): Request {
  return new Request("https://beacon.internal/ui/todo", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
}

describe("parseForm", () => {
  it("parses an application/x-www-form-urlencoded body into FormData", async () => {
    const form = await parseForm(formRequest("id=42&done=1"));
    expect(form).not.toBeNull();
    expect(form?.get("id")).toBe("42");
    expect(form?.get("done")).toBe("1");
  });

  it("returns an empty (not null) FormData for an empty body — a malformed body is not the same as an empty one", async () => {
    const form = await parseForm(formRequest(""));
    expect(form).not.toBeNull();
    expect(form?.get("id")).toBeNull();
  });
});

describe("formString", () => {
  it("returns the field's value when present and non-empty", async () => {
    const form = await parseForm(formRequest("title=hello%20world"));
    expect(formString(form!, "title")).toBe("hello world");
  });

  it("returns null when the field is absent", async () => {
    const form = await parseForm(formRequest("id=1"));
    expect(formString(form!, "title")).toBeNull();
  });

  it("returns null when the field is present but empty — an optional field submitted blank is treated as omitted", async () => {
    const form = await parseForm(formRequest("title="));
    expect(formString(form!, "title")).toBeNull();
  });
});

describe("safeRedirectPath", () => {
  it("accepts a plain relative path", () => {
    expect(safeRedirectPath("/todos?status=done", "/fallback")).toBe("/todos?status=done");
  });

  it("falls back when raw is null", () => {
    expect(safeRedirectPath(null, "/fallback")).toBe("/fallback");
  });

  it("falls back on a protocol-relative path (open-redirect vector)", () => {
    expect(safeRedirectPath("//evil.example/phish", "/fallback")).toBe("/fallback");
  });

  it("falls back on an absolute URL (open-redirect vector)", () => {
    expect(safeRedirectPath("https://evil.example/phish", "/fallback")).toBe("/fallback");
  });

  it("falls back on a path that doesn't start with /", () => {
    expect(safeRedirectPath("todos", "/fallback")).toBe("/fallback");
  });

  // Coordinator review (2026-08-10): browsers normalize a backslash to a forward
  // slash per the WHATWG URL spec, so "/\evil.com" — which passes a naive
  // startsWith("/")/!startsWith("//")/!includes("://") check — becomes the
  // network-path reference "//evil.com" once actually navigated, landing on
  // https://evil.com. Not exploitable today (every returnTo is a server-side
  // constant, and SameSite=Strict blocks cross-site POSTs from ever supplying
  // one), but rejecting exactly this is the function's only reason to exist.
  it("falls back on a backslash-prefixed path (browsers normalize \\ to / into a protocol-relative URL)", () => {
    expect(safeRedirectPath("/\\evil.com", "/fallback")).toBe("/fallback");
  });

  // Same root cause, different normalization: the WHATWG URL parser strips
  // ASCII tab/newline from the input before parsing, so "/\t/evil.com" becomes
  // "//evil.com" too.
  it("falls back on a path containing a raw tab character (browsers strip it, producing a protocol-relative URL)", () => {
    expect(safeRedirectPath("/\t/evil.com", "/fallback")).toBe("/fallback");
  });

  it("still accepts an ordinary path containing a backslash in the middle (not a host-changing normalization)", () => {
    expect(safeRedirectPath("/a\\b", "/fallback")).toBe("/a\\b");
  });
});
