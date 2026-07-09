# Podcast CMS — Event Sourcing Demo (Emmett + Hono + Cloudflare D1)

A demo API for managing podcast episodes, built as an event-sourced "hello world" with [Emmett](https://github.com/event-driven-io/emmett)'s decider pattern. The event store runs on Cloudflare D1 (`d1EventStoreDriver` from `@event-driven-io/emmett-sqlite/cloudflare`), HTTP via [Hono](https://hono.dev), executed in workerd through `wrangler dev` (local D1 persisted as SQLite under `.wrangler/state/`). The same code deploys unchanged to Cloudflare Workers + D1.

## Plans

| Plan | Delivered |
|---|---|
| [01 — Podcast CMS on Emmett + D1](docs/plan/01-podcast-cms-emmett-d1.md) | The event-sourced podcast CMS demo: Emmett event store on Cloudflare D1, Hono API with five business-grouped events, BDD red-green TDD, `X-User` header auth, audit history endpoint, and a list read model. |
| [02 — Idiomatic Hono auth errors](docs/plan/02-idiomatic-hono-auth-errors.md) | Refactored the auth middleware error paths to the Hono idiom — thrown `HTTPException`s — and unified all error responses as RFC 7807 `problem+json` via a shared `onError` handler. |

## Event catalog

Five events, grouped by why they happen rather than what field they touch:

| Event | Data | Grouping rationale |
|---|---|---|
| `EpisodeCreated` | `{ episode_number, title, episode_date }` | Birth of the stream; the required identity fields. |
| `EpisodeContentUpdated` | `Partial<{ title, intro, transcript, episode_date, link_notes, newsletter, summarization, yt_chapters, meta_seo, duration_ms }>` | One editorial action; only the keys actually changed are present. |
| `TranscriptReviewed` | `{}` | A workflow fact, not a data change — sets the `transcript_reviewed` flag. |
| `EpisodePublished` | `{ published_at }` | Repeatable publish log; each publish appends a new event and advances `last_published_at`. |
| `EpisodeDistributionUpdated` | `Partial<{ spotify_id, apple_url, youtube_id, spreaker_id, audio_url, teaser_video_url, discord_send }>` | Platform-sync concern, separate from editorial content; partial like content. |

**Metadata on every event:** `{ user, reason?, now }` — `user` from the `X-User` header, `reason` from the optional `X-Reason` header, `now` as an ISO 8601 timestamp.

**Why `X-Reason` is a header, not a body field:** it works uniformly across bodyless commands (publish, transcript review) and keeps PATCH bodies pure — "present keys = changed fields" with no reserved meta keys. It is also a natural place for future AI agents to explain themselves.

## Setup & run

Requires Node.js v24+.

```bash
npm install
git config core.hooksPath .githooks   # activates the non-blocking pre-commit feedback hook (build/test/lint)

npm run dev     # wrangler dev -> http://localhost:8787
npm test        # BDD decider + auth middleware specs (node --import tsx --test)
npm run build   # tsc --noEmit + wrangler deploy --dry-run (proves the Worker bundles)
npm run lint    # biome check .
```

## Auth (demo only — header-based identity, no real auth)

Identity is just the `X-User` header; a static map in `src/auth/permissions.ts` grants access per podcast (RW implies RO):

| User \ Podcast | `podcast-a` | `podcast-b` |
|---|---|---|
| `alice` | RW | RO |
| `bob` | — | RW |

Check order: unknown podcast → **404**; missing/unknown `X-User` → **401**; no grant, or RO grant on an RW route → **403**.

Auth failures are thrown as [`HTTPException`](https://hono.dev/docs/api/exception) per the Hono idiom, so ALL errors — auth included — are rendered as RFC 7807 `application/problem+json` by a single shared `onError` handler (`src/errors.ts`). Sample 401 body:

```json
{"type":"about:blank","title":"Unauthorized","detail":"Unknown or missing user","status":401}
```

`WWW-Authenticate` is deliberately omitted on 401 — `X-User` is demo pseudo-auth, not an HTTP auth scheme, so a challenge header would be misleading.

## API reference

All routes are prefixed `/podcasts/:podcastId`. Errors are `application/problem+json`.

| Method | Path | Access | Success | Errors |
|---|---|---|---|---|
| POST | `/podcasts/:p/episodes` | RW | 201 + weak ETag | 400 invalid body, 409 duplicate |
| PATCH | `/podcasts/:p/episodes/:n/content` | RW | 204 + weak ETag | 400 empty update, 404 not created |
| PATCH | `/podcasts/:p/episodes/:n/distribution` | RW | 204 + weak ETag | 400 empty update, 404 not created |
| POST | `/podcasts/:p/episodes/:n/transcript/review` | RW | 204 | 404 not created |
| POST | `/podcasts/:p/episodes/:n/publish` | RW | 204 (repeatable) | 400 missing required fields, 404 not created |
| GET | `/podcasts/:p/episodes/:n` | RO | 200 state + weak ETag | 404 |
| GET | `/podcasts/:p/episodes/:n/history` | RO | 200 audit trail | 404 |
| GET | `/podcasts/:p/episodes` | RO | 200 read-model list | — |

Plus auth errors on every route: 401 / 403 / 404 as per the check order above. Error mapping: `ValidationError` → 400, `IllegalStateError` → 403, `NotFoundError` → 404; version conflicts (duplicate create) are remapped from emmett's default 412 to **409**.

Publish is gated: when the episode is not ready it returns 400 `application/problem+json` with `detail` listing the missing required fields (`episode_number`, `episode_date`, `intro`, `spreaker_id`).

## Curl cookbook

With `npm run dev` running (replace `8787` with your port if overridden):

```bash
# happy path (alice = RW on podcast-a)
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes \
  -H 'X-User: alice' -H 'X-Reason: initial import' -H 'Content-Type: application/json' \
  -d '{"episode_number": 42, "title": "Event Sourcing 101", "episode_date": "2026-07-01"}'   # 201
curl -i -X PATCH localhost:8787/podcasts/podcast-a/episodes/42/content \
  -H 'X-User: alice' -H 'X-Reason: added transcript' -H 'Content-Type: application/json' \
  -d '{"transcript": "hello...", "duration_ms": 3600000, "intro": "Welcome!"}'                # 204
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes/42/transcript/review -H 'X-User: alice'  # 204
curl -i -X PATCH localhost:8787/podcasts/podcast-a/episodes/42/distribution \
  -H 'X-User: alice' -H 'Content-Type: application/json' \
  -d '{"spotify_id": "sp-123", "spreaker_id": "spr-42"}'                                      # 204
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes/42/publish -H 'X-User: alice' \
  -H 'X-Reason: initial release'                                                              # 204 (400 before intro+spreaker_id set)
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes/42/publish -H 'X-User: alice' \
  -H 'X-Reason: republish after fix'                                                          # 204 (repeatable)

# reads
curl -s localhost:8787/podcasts/podcast-a/episodes/42 -H 'X-User: alice'          # 200 state
curl -s localhost:8787/podcasts/podcast-a/episodes/42/history -H 'X-User: alice'  # 200 audit
curl -s localhost:8787/podcasts/podcast-a/episodes -H 'X-User: alice'             # 200 list

# permission matrix
curl -s localhost:8787/podcasts/podcast-b/episodes -H 'X-User: alice'    # 200 (RO read)
curl -i -X POST localhost:8787/podcasts/podcast-b/episodes -H 'X-User: alice' \
  -H 'Content-Type: application/json' -d '{"episode_number":1,"title":"t","episode_date":"2026-01-01"}'  # 403
curl -i localhost:8787/podcasts/podcast-a/episodes -H 'X-User: bob'      # 403 (no grant)
curl -i localhost:8787/podcasts/podcast-a/episodes -H 'X-User: mallory'  # 401
curl -i localhost:8787/podcasts/podcast-a/episodes                       # 401 (no header)
curl -i localhost:8787/podcasts/podcast-x/episodes -H 'X-User: alice'    # 404

# error paths
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes -H 'X-User: alice' \
  -H 'Content-Type: application/json' -d '{"episode_number":42,"title":"dup","episode_date":"2026-07-01"}'  # 409
curl -i -X PATCH localhost:8787/podcasts/podcast-a/episodes/42/content \
  -H 'X-User: alice' -H 'Content-Type: application/json' -d '{}'          # 400
```

## History endpoint — sample output

`GET /podcasts/podcast-a/episodes/42/history` replays the stream and diffs the state before/after each event into per-field changes (trimmed):

```json
{
  "stream_id": "episode-podcast-a-42",
  "entries": [
    {
      "stream_position": "1",
      "type": "EpisodeCreated",
      "user": "alice",
      "reason": "initial import",
      "timestamp": "2026-07-08T11:04:34.481Z",
      "changes": [
        { "field": "episode_number", "before": null, "after": 42 },
        { "field": "title", "before": null, "after": "Event Sourcing 101" },
        { "field": "episode_date", "before": null, "after": "2026-07-01" },
        { "field": "is_published", "before": null, "after": false },
        { "field": "transcript_reviewed", "before": null, "after": false }
      ]
    },
    {
      "stream_position": "4",
      "type": "EpisodePublished",
      "user": "alice",
      "reason": "initial release",
      "timestamp": "2026-07-08T11:05:02.113Z",
      "changes": [
        { "field": "is_published", "before": false, "after": true },
        { "field": "last_published_at", "before": null, "after": "2026-07-08T11:05:02.113Z" }
      ]
    }
  ]
}
```

## Read model caveat

The `episodes_list` table (backing `GET /podcasts/:p/episodes`) is an **inline projection** — it is updated in the same transaction as the event append, but it does **not backfill** from events that existed before the projection was registered. Local reset (wipes ALL local data, including events):

```bash
rm -rf .wrangler/state
```
