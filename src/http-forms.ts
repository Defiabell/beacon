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

// Guards the `returnTo` hidden field every /ui/* form carries before it's used
// as a redirect target: only a same-origin relative path is accepted. Blindly
// trusting a caller-supplied redirect target would be an open-redirect vector
// (`returnTo=https://evil.example`, or the protocol-relative `returnTo=//evil.example`,
// which browsers treat as an absolute URL despite having no scheme).
export function safeRedirectPath(raw: string | null, fallback: string): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("://")) return raw;
  return fallback;
}
