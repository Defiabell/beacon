English | [简体中文](README.zh-CN.md)

# beacon

A growth engine for your side projects — self-hosted on Cloudflare's free tier. beacon watches GitHub traffic/stars and the posts you've made about a project, tells you which channels you haven't posted to yet, and audits every tracked repo's README/topics/license against a public-facing checklist — then turns whatever's missing into a todo.

![beacon overview](docs/screenshot.png)
<!-- TODO: replace with a real screenshot of the "/" overview page once deployed -->

## What it is

beacon is a single **Cloudflare Worker + D1 database**, organized around three layers:

- **Measure** — a daily cron (`0 1 * * *` UTC, see `wrangler.toml`) pulls each tracked repo's GitHub traffic/clones/star history (`src/collect/github.ts`), refreshes metrics for every post you've registered on V2EX/LinuxDO/Hacker News/Reddit (`src/collect/posts.ts`), and — optionally — daily pageviews from a GoatCounter site (`src/collect/goatcounter.ts`).
- **Discover** — a repo exposure audit (`src/audit/checks.ts`) runs 9 checks per tracked repo (description length, ≥3 topics, LICENSE present, English intro in the README, screenshot/GIF in the README, release assets for macOS projects, no broken README links, custom social-preview image, homepage synced), and a channel-coverage matrix (`src/channels.ts`) scores each project against 17 launch channels (V2EX, LinuxDO, 少数派, Show HN, r/SideProject, itch.io, …) by tag overlap, so you can see at a glance where you haven't posted yet.
- **Act** — every failed audit check and every high-scoring unposted channel becomes a row in `todos`, surfaced on the dashboard and via `/api/todos` — a concrete next action instead of just a report.

Everything is served by one Worker: a public, unauthenticated SSR dashboard (`/`, `/p/:project`, `/matrix`, `/todos`, `/posts`) plus a Bearer-token-gated admin API for writes (`/api/admin/*`). Every GET response outside `/api/admin/*` also goes through the Workers Cache API — on a custom domain (not a bare `workers.dev` subdomain) this gives true edge caching in addition to the `max-age=60` browser cache.

## Deploy your own (~5 min)

Prereqs: a Cloudflare account and Node 18+.

```bash
git clone https://github.com/Defiabell/beacon
cd beacon
npm install
npx wrangler login

# 1. create the D1 database (name must match wrangler.toml's database_name = "beacon")
npx wrangler d1 create beacon
# copy the returned `database_id` into wrangler.toml's [[d1_databases]] block —
# it ships with database_id = "placeholder-replace-after-d1-create"

# 2. apply the schema
npx wrangler d1 migrations apply beacon --remote

# 3. set the GitHub token — a fine-grained PAT scoped to just the repos you track:
#    - Administration: Read-only  (required by the traffic API — GET /repos/{owner}/{repo}/traffic/*
#      only works for a token with push/admin-level access to the repo)
#    - Contents: Read-only        (README and releases — basic repo metadata like
#      description/topics/license is covered by every token's built-in, non-optional
#      Metadata:Read permission)
# Star history backfill (GitHub's stargazers API) needs no extra permission for a
# public repo — it's unauthenticated-readable; the token here just lifts you out of
# the much lower unauthenticated rate limit.
npx wrangler secret put GITHUB_TOKEN

# 4. set the admin token — any long random string; it gates every /api/admin/* write
openssl rand -hex 24                  # generate one, copy it
npx wrangler secret put ADMIN_TOKEN   # paste it when prompted

# 5. point beacon at your own projects — edit src/config.ts,
#    replacing the sample entries with your GitHub repos + tags

# 6. deploy
npm run deploy
```

You also need a **workers.dev subdomain** (Dashboard → Workers & Pages, one-time) or a custom domain. After deploy you get `https://beacon.<your-subdomain>.workers.dev`.

Finally, seed history and run the first collection:

```bash
# backfills full star history per project from GitHub's stargazers API
curl -X POST https://beacon.<your-subdomain>.workers.dev/api/admin/backfill \
  -H "Authorization: Bearer <ADMIN_TOKEN>"

# runs today's collectors immediately (the daily cron does the same thing
# automatically from tomorrow on, split across two invocations — see below).
# A single call with no ?sources= runs all four collectors (github, posts,
# goatcounter, audit) in one invocation, which on a multi-repo fleet gets
# close to the Workers free tier's 50-subrequests-per-invocation cap. The
# two-step form below is the safe way to do this by hand — same split the
# cron itself uses (wrangler.toml's two crons + src/index.ts):
curl -X POST "https://beacon.<your-subdomain>.workers.dev/api/admin/collect?sources=github,posts,goatcounter" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
curl -X POST "https://beacon.<your-subdomain>.workers.dev/api/admin/collect?sources=audit" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Open `https://beacon.<your-subdomain>.workers.dev/` — the overview should now show stars/traffic for every project in `src/config.ts`.

## GoatCounter (optional)

beacon can also pull daily pageviews/visitors for a [GoatCounter](https://www.goatcounter.com/) site into the same dashboard (`src/collect/goatcounter.ts`):

```bash
npx wrangler secret put GOATCOUNTER_SITE    # your <site>.goatcounter.com code, e.g. "defiabell"
npx wrangler secret put GOATCOUNTER_TOKEN   # GoatCounter → Settings → API → generate a token
```

Leave both unset and the daily "goatcounter" collector step simply reports `{ok: true, error: "not configured"}` and skips — nothing else in beacon depends on it.

See [`docs/goatcounter.md`](docs/goatcounter.md) for the tracking snippet to embed on your own sites and how to verify it's sending hits.

## Admin API

Every `/api/admin/*` route requires `Authorization: Bearer <ADMIN_TOKEN>`.

**Register a post you published** — metrics are fetched immediately when possible; if the platform hiccups, the post is still saved and picked up by the next collection:

```bash
curl -X POST https://beacon.<subdomain>.workers.dev/api/admin/posts \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://news.ycombinator.com/item?id=12345678", "project": "shotsync", "title": "Show HN: shotsync", "publishedAt": "2026-07-15T09:00:00Z"}'
# -> 201 {"id": 7}
# or, if the platform's metrics API failed on this first try:
# -> 201 {"id": 7, "metrics": "deferred"}
```

`publishedAt` is optional (an ISO 8601 string) — omit it and the post is stored with no publish date, same as before.

**Mark a channel as posted / planned / not applicable:**

```bash
curl -X PUT https://beacon.<subdomain>.workers.dev/api/admin/channels \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project": "shotsync", "channelId": "show-hn", "status": "posted", "postId": 7}'
# -> 204 No Content
```

**Close (or reopen) a todo:**

```bash
curl -X PUT https://beacon.<subdomain>.workers.dev/api/admin/todos \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": 3, "status": "done"}'
# -> 204 No Content
```

**Trigger a collection or backfill manually** (same routes used in the deploy steps above):

```bash
# all four collectors in one call — near the free tier's subrequest cap on a
# multi-repo fleet (see the deploy steps above for the safer two-step form)
curl -X POST https://beacon.<subdomain>.workers.dev/api/admin/collect \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> 200 [{"source":"github","ok":true}, {"source":"posts","ok":true}, ...]

# ?sources=<comma-separated names> restricts the run to a subset of
# github/posts/goatcounter/audit; an unknown name 400s
curl -X POST "https://beacon.<subdomain>.workers.dev/api/admin/collect?sources=audit" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> 200 [{"source":"audit","ok":true}]

curl -X POST https://beacon.<subdomain>.workers.dev/api/admin/backfill \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> 200 {"repos": 4, "failures": []}
```

### Reading the data back

No token needed — these are public:

- `GET /` `/p/:project` `/matrix` `/todos` `/posts` — the HTML dashboard
- `GET /api/overview` `/api/matrix` `/api/posts` `/api/health` `/api/todos?status=open|done` `/api/project/:name` — the same data as JSON

## Development

```bash
npm test          # vitest run — full suite (Vitest + @cloudflare/vitest-pool-workers)
npm run typecheck # tsc --noEmit (src) + tsc -p test --noEmit
npm run dev       # wrangler dev — local dev server
```

## License

[MIT](LICENSE)
