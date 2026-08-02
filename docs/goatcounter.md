# GoatCounter setup

beacon's optional GoatCounter collector (`src/collect/goatcounter.ts`) pulls **daily pageviews/visitors** for a site you already track with [GoatCounter](https://www.goatcounter.com/) — it does not create or manage the GoatCounter site itself. This doc covers the two sides of that: embedding the tracking snippet on the sites you want measured, and wiring beacon up to read the stats back.

## 1. Create (or reuse) a GoatCounter site

If you don't have one yet: sign up at goatcounter.com and create a site — you'll get a site code, e.g. `defiabell`, which serves stats at `https://defiabell.goatcounter.com`.

## 2. Embed the tracking snippet

Add this near the end of `<head>` (or just before `</body>`) on every page you want counted, replacing `SITE` with your site code:

```html
<script data-goatcounter="https://SITE.goatcounter.com/count" async src="//SITE.goatcounter.com/count.js"></script>
```

Where to put it for the two properties this project cares about:

- **博客（defiabell.github.io）** — add the snippet to the site's shared layout/template (e.g. a `_layouts/default.html` or equivalent in that Jekyll/static-site repo) so every post picks it up, rather than pasting it into individual post files.
- **夜潮（nightide）游戏页** — the built page served on GitHub Pages is `personal-projects/nightide/packages/client/index.html` (source; the deployed HTML lives in the separate `Defiabell/nightide` Pages repo, not this one). Add the snippet inside `<head>`, after the existing `<meta>`/`<title>` tags and before the closing `</head>` — it only needs to load once per page view, the game itself doesn't need to call it.

Both are static pages with a single `<head>`, so no framework-specific integration (e.g. a Next.js `<Script>` component) is needed — a plain `<script>` tag is enough.

## 3. Verify it's sending hits

1. Visit the page in a normal (non-bot, non-headless) browser tab.
2. Open your GoatCounter dashboard at `https://SITE.goatcounter.com` and log in.
3. The visit should show up within a few seconds under "Pages" / the realtime count on the dashboard home. If it doesn't appear:
   - Check the browser console for a blocked request (ad blockers / strict tracking-protection extensions block GoatCounter — this is expected and by design, not a misconfiguration).
   - Confirm the `SITE` in both the `data-goatcounter` URL and the script `src` matches your actual site code exactly.

## 4. Wire it into beacon

Once the site is live and receiving hits, point your beacon deployment at it:

```bash
npx wrangler secret put GOATCOUNTER_SITE    # e.g. "defiabell"
npx wrangler secret put GOATCOUNTER_TOKEN   # GoatCounter → Settings → API → generate a token
```

`GOATCOUNTER_SITE`/`GOATCOUNTER_TOKEN` are read by `src/collect/goatcounter.ts`'s `fetchSiteDaily`, which calls `GET https://{site}.goatcounter.com/api/v0/stats/total?start=...&end=...` with `Authorization: Bearer {token}` during the daily collector run (`src/collect/run.ts`'s `collectGoatcounter`) and stores the result in the `site_daily` table. Leaving either secret unset is fine — that step reports `{ok: true, error: "not configured"}` and skips, without affecting the GitHub/posts/audit collectors.

See the main [README](../README.md#goatcounter-optional) for the full secrets list and deploy flow.
