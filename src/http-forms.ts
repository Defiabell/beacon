// Tiny shared helpers for parsing the `application/x-www-form-urlencoded` POST
// bodies submitted by the project's plain-HTML <form>s (no client-side JS
// anywhere) — used by /login (src/api/session.ts) and every /ui/* route
// (src/api/ui.ts). Every one of those follows the POST/redirect/GET pattern:
// parse the form, do the write, 303 back to wherever the form was rendered.

// Returns null (rather than throwing) on a malformed body so callers can turn
// it into a 400 instead of an unhandled rejection / 500 — same contract as
// src/api/admin.ts's parseJsonBody.
export async function parseForm(req: Request): Promise<FormData | null> {
  try {
    return await req.formData();
  } catch {
    return null;
  }
}

// Returns the named field's value, or null when absent *or empty*. An empty
// text input still submits its name with an empty-string value (unlike a JSON
// body, which can simply omit the key) — treating "" as "not provided" here
// keeps an optional form field (title, publishedAt) behaving the same as an
// omitted JSON field, rather than writing an empty string to the database.
export function formString(form: FormData, key: string): string | null {
  const v = form.get(key);
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Fixed, fake origin (RFC 2606 reserves the .invalid TLD for exactly this) used
// only to detect whether `raw` — once resolved as a URL reference — would
// navigate somewhere other than "here". Never used for anything else, and
// never sent anywhere.
const REDIRECT_PROBE_ORIGIN = "http://beacon.invalid";

// Guards the `returnTo` hidden field every /ui/* form carries before it's used
// as a redirect target: only a same-origin relative path is accepted. Blindly
// trusting a caller-supplied redirect target would be an open-redirect vector —
// obviously so for `returnTo=https://evil.example` or the protocol-relative
// `returnTo=//evil.example`, but a naive `startsWith("/") && !startsWith("//")
// && !includes("://")` check (this function's first version) still misses two
// real browser-normalization tricks that turn a path *starting* with a single
// "/" into a network-path reference once actually parsed/navigated:
//   - `/\evil.com`      — browsers treat "\" as "/" in a URL (WHATWG URL spec),
//                          so this becomes "//evil.com" -> https://evil.com.
//   - `/\t/evil.com`    — the URL parser strips ASCII tab/newline from the
//                          input before parsing, so this also collapses to
//                          "//evil.com".
// Resolving `raw` against a fixed synthetic origin and comparing the result's
// origin back to it catches both (and any other WHATWG-normalization variant
// of the same trick) in one mechanism, rather than hand-maintaining a
// blocklist of characters — see test/http-forms.test.ts for both cases plus a
// same-origin control case (a literal backslash *not* at a host-changing
// position, e.g. "/a\b", must still be accepted).
export function safeRedirectPath(raw: string | null, fallback: string): string {
  if (!raw || !raw.startsWith("/")) return fallback;
  try {
    if (new URL(raw, REDIRECT_PROBE_ORIGIN).origin !== REDIRECT_PROBE_ORIGIN) return fallback;
  } catch {
    return fallback;
  }
  return raw;
}
