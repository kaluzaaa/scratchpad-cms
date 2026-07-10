# Podcast CMS — Event Sourcing Demo (Emmett + Hono + Cloudflare D1)

A demo API for managing podcast episodes, built as an event-sourced "hello world" with [Emmett](https://github.com/event-driven-io/emmett)'s decider pattern. The event store runs on Cloudflare D1 (`d1EventStoreDriver` from `@event-driven-io/emmett-sqlite/cloudflare`), the read model is a [Pongo](https://event-driven-io.github.io/Pongo/) document collection on the same D1 database, HTTP via [Hono](https://hono.dev), executed in workerd through `wrangler dev` (local D1 persisted as SQLite under `.wrangler/state/`). The same code deploys unchanged to Cloudflare Workers + D1.

## Plans

| Plan | Delivered |
|---|---|
| [01 — Podcast CMS on Emmett + D1](docs/plan/01-podcast-cms-emmett-d1.md) | The event-sourced podcast CMS demo: Emmett event store on Cloudflare D1, Hono API with five business-grouped events, BDD red-green TDD, `X-User` header auth, audit history endpoint, and a list read model. |
| [02 — Idiomatic Hono auth errors](docs/plan/02-idiomatic-hono-auth-errors.md) | Refactored the auth middleware error paths to the Hono idiom — thrown `HTTPException`s — and unified all error responses as RFC 7807 `problem+json` via a shared `onError` handler. |
| [03 — Oskar review refactor](docs/plan/03-oskar-review-refactor.md) | Applied Oskar Dudycz's review: explicit business ids in event data, metadata without `now`, inline event payloads, a hard publication gate, a Pongo read model on D1, two-stage transcript import, a slim aggregate, and Emmett `ApiSpecification` HTTP-layer tests. |

## Event catalog

Six events, grouped by why they happen rather than what field they touch:

| Event | Data | Grouping rationale |
|---|---|---|
| `EpisodeCreated` | `{ podcast_id, episode_number, title, episode_date }` | Birth of the stream; the required identity fields. Business ids are explicit in the data, never derived from the stream id. |
| `EpisodeContentUpdated` | `Partial<{ title, intro, episode_date, link_notes, newsletter, summarization, yt_chapters, meta_seo, duration_ms }>` | One editorial action; only the keys actually changed are present. |
| `TranscriptDraftImported` | `{ podcast_id, episode_number, transcript }` | HappyScribe draft transcript import; does not mark the transcript reviewed. |
| `ReviewedTranscriptImported` | `{ podcast_id, episode_number, transcript }` | Reviewed import (proofreader's email) overwriting the same field; sets the `transcript_reviewed` flag, which gates transcript publication — not episode publication. |
| `EpisodePublished` | `{ published_at }` | Repeatable publish log; each publish appends a new event and advances `last_published_at`. `published_at` is a server-generated business fact passed as command data (not metadata). |
| `EpisodeDistributionUpdated` | `Partial<{ spotify_id, apple_url, youtube_id, spreaker_id, audio_url, teaser_video_url, discord_send }>` | Platform-sync concern, separate from editorial content; partial like content. |

**Metadata on every event:** `{ user, reason? }` — `user` from the `X-User` header, `reason` from the optional `X-Reason` header (the key is present only when the header was sent). There is no timestamp in metadata — the event store records the time itself, and the history endpoint reads that recorded time.

**Why `X-Reason` is a header, not a body field:** it works uniformly across bodyless commands (publish) and keeps PATCH bodies pure — "present keys = changed fields" with no reserved meta keys. It is also a natural place for future AI agents to explain themselves.

## Setup & run

Requires Node.js v24+.

```bash
npm install
git config core.hooksPath .githooks   # activates the non-blocking pre-commit feedback hook (build/test/lint)

npm run dev     # wrangler dev -> http://localhost:8787
npm test        # all three test layers (node --import tsx --test), see Testing below
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
| POST | `/podcasts/:p/episodes/:n/transcript/draft` | RW | 204 | 400 invalid body, 404 not created |
| POST | `/podcasts/:p/episodes/:n/transcript/reviewed` | RW | 204 | 400 invalid body, 404 not created |
| POST | `/podcasts/:p/episodes/:n/publish` | RW | 204 (repeatable) | 400 missing required fields, 404 not created |
| GET | `/podcasts/:p/episodes/:n` | RO | 200 episode document + weak ETag | 404 |
| GET | `/podcasts/:p/episodes/:n/history` | RO | 200 audit trail | 404 |
| GET | `/podcasts/:p/episodes` | RO | 200 document list | — |

Plus auth errors on every route: 401 / 403 / 404 as per the check order above. Error mapping: `ValidationError` → 400, `IllegalStateError` → 403, `NotFoundError` → 404; version conflicts (duplicate create) are remapped from emmett's default 412 to **409**.

Publish is gated: when the episode is not ready it returns 400 `application/problem+json` with `detail` listing the missing required fields (`episode_number`, `episode_date`, `intro`, `spreaker_id`).

Transcript is **read-only in the content PATCH** — it is written only via the two import routes (body `{ transcript }`, non-empty string), modeling the real flow: HappyScribe draft import, then the reviewed import (after the proofreader's email) overwriting the same field. The reviewed flag gates transcript publication, not episode publication.

## Curl cookbook

With `npm run dev` running (replace `8787` with your port if overridden):

```bash
# happy path (alice = RW on podcast-a)
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes \
  -H 'X-User: alice' -H 'X-Reason: initial import' -H 'Content-Type: application/json' \
  -d '{"episode_number": 42, "title": "Event Sourcing 101", "episode_date": "2026-07-01"}'   # 201
curl -i -X PATCH localhost:8787/podcasts/podcast-a/episodes/42/content \
  -H 'X-User: alice' -H 'X-Reason: editorial pass' -H 'Content-Type: application/json' \
  -d '{"duration_ms": 3600000, "intro": "Welcome!"}'                                          # 204
curl -i -X PATCH localhost:8787/podcasts/podcast-a/episodes/42/distribution \
  -H 'X-User: alice' -H 'Content-Type: application/json' \
  -d '{"spotify_id": "sp-123", "spreaker_id": "spr-42"}'                                      # 204
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes/42/transcript/draft \
  -H 'X-User: alice' -H 'Content-Type: application/json' \
  -d '{"transcript": "draft from HappyScribe..."}'                                            # 204
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes/42/transcript/reviewed \
  -H 'X-User: alice' -H 'Content-Type: application/json' \
  -d '{"transcript": "reviewed by the proofreader..."}'                                       # 204 (overwrites the draft)
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes/42/publish -H 'X-User: alice' \
  -H 'X-Reason: initial release'                                                              # 204 (400 before intro+spreaker_id set)
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes/42/publish -H 'X-User: alice' \
  -H 'X-Reason: republish after fix'                                                          # 204 (repeatable)

# reads
curl -s localhost:8787/podcasts/podcast-a/episodes/42 -H 'X-User: alice'          # 200 document
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

`GET /podcasts/podcast-a/episodes/42/history` replays the stream through the read-model document evolve (full data, not the slim aggregate) and diffs the document before/after each event into per-field changes. `timestamp` is the event store's recorded time (its `created` column) — there is no timestamp in event metadata. Trimmed sample:

```json
{
  "stream_id": "episode-podcast-a-42",
  "entries": [
    {
      "stream_position": "1",
      "type": "EpisodeCreated",
      "user": "alice",
      "reason": "initial import",
      "timestamp": "2026-07-08T11:04:34Z",
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
      "timestamp": "2026-07-08T11:05:02Z",
      "changes": [
        { "field": "is_published", "before": false, "after": true },
        { "field": "last_published_at", "before": null, "after": "2026-07-08T11:05:02.113Z" }
      ]
    }
  ]
}
```

## Testing

`npm test` runs three layers, all through node:test:

1. **Decider units** (`businessLogic.spec.ts`) — emmett's `DeciderSpecification`: given events, when command, then events/error. Pure, no HTTP, no store.
2. **Outside-in HTTP specs** (`api.spec.ts`) — emmett's Hono-native `ApiSpecification` drives real requests through the real stack (auth, parsing, decider, problem+json mapping) over an **in-memory** event store; command routes only.
3. **D1 integration** (`api.d1.spec.ts`) — [Miniflare](https://miniflare.dev) provides a real D1 database in-process and the production app from `src/index.ts` runs the full episode journey against it: the inline Pongo projection, the GETs served from the projected document, and the history timestamps read from the store's messages table.

## Write model vs read model

The aggregate (write model) is **slim** — it holds only what the invariants read: `episode_number`, `episode_date`, the presence flags `has_intro` / `has_spreaker_id` (the effective publish gate), `is_published`, `transcript_reviewed`, and `last_published_at`. Full episode data lives in the events and in the [Pongo](https://event-driven-io.github.io/Pongo/) `episodes` collection: one document per episode (`_id` = stream id) that backs both `GET /podcasts/:p/episodes` and `GET /podcasts/:p/episodes/:n` (ETag from the document `_version`). The history endpoint replays the same document evolve, so the audit diff sees the full data too.

The collection is maintained by an **inline projection** (emmett's `pongoSingleStreamProjection`; on D1 it requires the pinned pongo >= 0.17.0-beta.42 / emmett >= 0.43.0-beta.26 stack): the collection table is auto-created on schema migration (no hand-written DDL) and updated together with the event append, but it does **not backfill** from events that existed before the projection was registered. Local reset (wipes ALL local data, including events):

```bash
rm -rf .wrangler/state
```

**D1 transaction guarantees, precisely:** D1 has no real SQL transactions. The emmett D1 driver simulates atomicity with a single session batch plus batch-level optimistic concurrency — an exception anywhere in the batch (e.g. a constraint violation or the no-changes guard) rolls back the WHOLE batch, so an event append and its inline projection update succeed or fail together. The residual, theoretical risk is a silent zero-row write that no guard catches; if that ever bites, the read-model document can always be rebuilt by replaying events.
