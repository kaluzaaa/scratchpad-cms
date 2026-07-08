# Event-Sourced Podcast CMS Demo — Emmett + Hono + Cloudflare D1

## Context

Demo of event sourcing with [Emmett](https://github.com/event-driven-io/emmett) as a "hello world" podcast CMS API. Goals: learn/showcase Emmett's decider pattern, avoid the [property sourcing anti-pattern](https://event-driven.io/en/property-sourcing/) (events grouped by business operation, not per field), BDD tests via `DeciderSpecification` in **red-green TDD flow**, SQLite-backed event store, full audit history endpoint. Runs locally now via `wrangler dev` (workerd + local D1); later deployable to Cloudflare Workers + D1 unchanged.

**Architecture (user-confirmed):** ONE driver everywhere — `d1EventStoreDriver` from `@event-driven-io/emmett-sqlite/cloudflare`. Local dev = `npx wrangler dev` (Miniflare persists local D1 as SQLite under `.wrangler/state/`). No `sqlite3` native addon, no `startAPI` — entry is `export default app` (Hono fetch handler).

**Toolchain (user-confirmed):** plain **Node (v24) + npm + tsc** — no Bun. Tests via `node --import tsx --test` (exactly what emmett samples use). **Biome** as linter + formatter, wired as a Claude Code PostToolUse hook (runs on every edited `.ts` file) and in the pre-commit feedback script. **Non-blocking pre-commit git hook**: runs build + tests + lint, prints PASS/FAIL feedback, always exits 0 (intentional red-phase commits are allowed; outside red phases build and tests must pass).

**Execution rules (CLAUDE.md):** everything written in English; coding done via subagents that receive the CLAUDE.md rules; each checklist task = one commit; subagent marks task `- [x]` in `docs/plan/01-podcast-cms-emmett-d1.md` before committing. A read-only reference clone of emmett goes to sibling path `/root/patoarchitekci/emmett` (never committed).

## Ground-truth facts (verified against npm + emmett main, 2026-07-08)

1. **Pin `0.43.0-beta.23` exactly** (no `^`) for `@event-driven-io/emmett`, `emmett-sqlite`, `emmett-honojs`. Stable `0.42.3` has NO `/cloudflare` subpath — the driver API exists only on the beta line. All three must be the same version (honojs peer-requires it).
2. **`sqliteSingleStreamProjection` does NOT exist.** Use **`sqliteRawSQLProjection`** (plain relational table; pattern: `samples/webApi/expressjs-with-sqlite/src/shoppingCarts/getShortInfo/index.ts`).
3. `schema: { autoMigration: 'None' }` + explicit `await eventStore.schema.migrate()` is the D1 pattern proven by emmett's own `SQLiteEventStore.d1.e2e.spec.ts`.
4. `emmett-honojs` barrel re-exports `@hono/node-server` (→ `node:http`) — needs `compatibility_flags: ["nodejs_compat"]` in wrangler config. Fallback if bundling breaks: plain `new Hono()` + ~15-line copy of the problem-details `onError` mapper (pre-approved deviation).
5. `nextExpectedStreamVersion` is a **bigint** — never `JSON.stringify` raw; use `toWeakETag()` for ETag headers.
6. Environment has node v24.17.0 + npm; emmett samples run tests with `node --import tsx --test` — follow that (tsx as devDependency; avoids native type-stripping's `.ts`-extension import requirement).

## Tooling

- `package.json` scripts:
  - `dev`: `wrangler dev`
  - `test`: `node --import tsx --test "src/**/*.spec.ts"`
  - `typecheck`: `tsc --noEmit`
  - `build`: `npm run typecheck && wrangler deploy --dry-run --outdir=dist` (dry-run proves the Worker bundles — catches the honojs/node-server risk on every commit)
  - `lint`: `biome check .` / `format`: `biome check --write .`
- **Biome**: single devDependency + `biome.json` (formatter + linter, recommended rules).
- **Claude Code hook** (`.claude/settings.json`, committed): PostToolUse on `Edit|Write` — extract `tool_input.file_path` from stdin JSON; if it ends with `.ts`, run `npx biome check --write "$file"`. Small script `scripts/biome-hook.sh` to keep the JSON clean.
- **Pre-commit feedback hook** (non-blocking): `.githooks/pre-commit` runs `npm run build`, `npm test`, `npm run lint`, prints a PASS/FAIL summary per step, **always exits 0**. Activated via `git config core.hooksPath .githooks` (done in Task 1, documented in README). Purpose: feedback only — red-phase commits are expected to show failing tests; any other commit should show all green.

## Domain design

### Events (grouped per property-sourcing article; optional fields = only changed keys present)

Metadata on every event: `{ user: string; reason?: string; now: string /* ISO */ }` — `user` from `X-User` header, `reason` from optional `X-Reason` header (uniform across bodyless commands like publish; keeps PATCH bodies pure "present keys = changed fields"; designed for future AI agents).

1. `EpisodeCreated` — `{ episode_number, title, episode_date }`
2. `EpisodeContentUpdated` — `Partial<{ title, intro, transcript, episode_date, link_notes, newsletter, summarization, yt_chapters, meta_seo, duration_ms }>`
3. `TranscriptReviewed` — no data (workflow event; sets `transcript_reviewed`)
4. `EpisodePublished` — `{ published_at }` in data (so `evolve` needs only `(state, {type, data})`); repeatable; action only logs + sets `is_published`/`last_published_at`
5. `EpisodeDistributionUpdated` — `Partial<{ spotify_id, apple_url, youtube_id, spreaker_id, audio_url, teaser_video_url, discord_send }>`

Conventions: snake_case field names in event data/state/API JSON (zero mapping); all timestamps ISO 8601 strings.

### State

Discriminated union; "not created" is explicit:

```ts
type Episode =
  | { status: 'NotCreated' }
  | { status: 'Created'; episode_number; title; episode_date;
      intro?; transcript?; link_notes?; newsletter?; summarization?; yt_chapters?;
      meta_seo?; duration_ms?; spotify_id?; apple_url?; youtube_id?; spreaker_id?;
      audio_url?; teaser_video_url?; discord_send?;
      is_published: boolean; transcript_reviewed: boolean; last_published_at? };
```

Stream id: `episode-{podcastId}-{episodeNumber}` via `episodeStreamId()` helper (single source of truth). State always read via `eventStore.aggregateStream(streamId, { evolve, initialState })`.

### Decider guards

- `CreateEpisode`: state must be `NotCreated` (`IllegalStateError`); endpoint passes `expectedStreamVersion: STREAM_DOES_NOT_EXIST` → duplicate = 409.
- `UpdateEpisodeContent`/`UpdateEpisodeDistribution`: requires `Created` (`NotFoundError`); empty update (no allowed key present) → `ValidationError` → 400.
- `ReviewTranscript`: requires `Created`; repeat allowed.
- `PublishEpisode`: requires `Created`; explicitly repeatable — each publish appends a new `EpisodePublished` (publish log).

Wiring: `const handle = CommandHandler({ evolve, initialState })`; `await handle(eventStore, streamId, (state) => decide(command, state))`.

### Auth (static config, no real auth)

`src/auth/permissions.ts`: `PODCAST_IDS = ['podcast-a', 'podcast-b']`; map e.g. `alice: { 'podcast-a': 'RW', 'podcast-b': 'RO' }, bob: { 'podcast-b': 'RW' }`. Middleware factory `requireAccess('RO'|'RW')` per route; check order: unknown podcast → **404**; missing/unknown `X-User` → **401**; no grant or RO-on-RW → **403**; else `c.set('user', ...)`. Pure `canAccess()` beside the map for unit testing.

### Endpoints

| Route | Access | Success |
|---|---|---|
| POST `/podcasts/:p/episodes` | RW | 201 + weak ETag; duplicate → 409 |
| PATCH `/podcasts/:p/episodes/:n/content` | RW | 204; empty body → 400 |
| PATCH `/podcasts/:p/episodes/:n/distribution` | RW | 204 |
| POST `/podcasts/:p/episodes/:n/transcript/review` | RW | 204 |
| POST `/podcasts/:p/episodes/:n/publish` | RW | 204 (repeatable) |
| GET `/podcasts/:p/episodes/:n` | RO | 200 state via `aggregateStream`; `!streamExists` → 404 |
| GET `/podcasts/:p/episodes/:n/history` | RO | 200 audit trail |
| GET `/podcasts/:p/episodes` | RO | 200 read-model list |

Errors via emmett-honojs problem-details middleware (`ValidationError`→400, `NotFoundError`→404, `IllegalStateError`→403, version conflict→409/412 — confirm defaults during endpoint task, override with `mapError` if needed).

### History endpoint (audit trail)

`readStream(streamId)` (events include metadata), then incremental replay:

```
state = initialState()
for each event: next = evolve(state, event)
  changes = FIELDS where state[k] !== next[k]  →  { field, before: ?? null, after: ?? null }
  entries += { stream_position, type, user, reason ?? null, timestamp: metadata.now, changes }
  state = next
```

`FIELDS` = fixed episode field list (excl. `status`); equality via `JSON.stringify` (covers `meta_seo` blob, KISS). Empty stream → 404.

### Read model (list)

`sqliteRawSQLProjection`: `init` → `CREATE TABLE IF NOT EXISTS episodes_list (stream_id TEXT PRIMARY KEY, podcast_id TEXT, episode_number INTEGER, title TEXT, episode_date TEXT, last_published_at TEXT)`; `canHandle: ['EpisodeCreated','EpisodeContentUpdated','EpisodePublished']`; evolve → INSERT ON CONFLICT / UPDATE SQL. Registered via `projections.inline([...])` (same transaction as append). `podcast_id`/`stream_id` derived from read-event `metadata.streamName` — **verify in read-model task**; fallback: add `podcast_id` to `EpisodeCreated` data. List endpoint queries D1 binding directly: `c.env.DB.prepare('SELECT ... FROM episodes_list WHERE podcast_id = ?1 ORDER BY episode_number')`. Caveat: inline projections don't backfill — local reset = `rm -rf .wrangler/state`.

### Store wiring (per-isolate lazy singleton)

```ts
// src/eventStore.ts
let initialized: Promise<EventStore> | undefined;
export const getEventStore = (db: D1Database) =>
  (initialized ??= (async () => {
    const store = getSQLiteEventStore({
      driver: d1EventStoreDriver, database: db,
      schema: { autoMigration: 'None' },
      projections: projections.inline([episodesListProjection]),
    });
    await store.schema.migrate();
    // fallback: run projection init SQL here if migrate() doesn't (verify in read-model task)
    return store;
  })());
```

Hono middleware sets it per request; app typed `Hono<{ Bindings: { DB: D1Database }, Variables: { eventStore, user } }>`.

## Repo structure

```
├── package.json           # pinned emmett deps; scripts dev/test/typecheck/build/lint/format
├── tsconfig.json          # strict, moduleResolution bundler, workers-types
├── wrangler.jsonc         # main src/index.ts, nodejs_compat, D1 binding DB
├── biome.json             # linter + formatter config
├── .claude/settings.json  # PostToolUse hook: biome on edited .ts files
├── .githooks/pre-commit   # non-blocking build+test+lint feedback (exit 0)
├── scripts/biome-hook.sh  # stdin JSON → file_path → biome check --write
├── README.md              # setup, curl cookbook, auth matrix, event catalog
├── docs/plan/01-podcast-cms-emmett-d1.md   # this plan + checklist (CLAUDE.md rule)
└── src/
    ├── index.ts           # app assembly, store middleware, export default
    ├── env.ts             # Bindings/Variables types
    ├── eventStore.ts      # lazy D1 store factory + migrate + projections
    ├── auth/
    │   ├── permissions.ts     # podcast ids + static user→podcast→RW/RO map
    │   ├── middleware.ts      # requireAccess + X-User/X-Reason extraction
    │   └── middleware.spec.ts
    └── episodes/
        ├── episode.ts         # events, metadata, state, evolve, initialState, streamId
        ├── businessLogic.ts   # commands, decide, metadata stamping
        ├── businessLogic.spec.ts  # DeciderSpecification BDD (node --test)
        ├── api.ts             # all 8 routes
        ├── history.ts         # replay + per-field diff
        └── readModel.ts       # episodes_list projection + list query
```

## Reference material for coding subagents

Clone emmett read-only to `/root/patoarchitekci/emmett` (sibling, never committed). Key files (raw URL prefix `https://raw.githubusercontent.com/event-driven-io/emmett/main/`):

- D1 store + migrate pattern: `src/packages/emmett-sqlite/src/eventStore/SQLiteEventStore.d1.e2e.spec.ts`, `src/packages/emmett-sqlite/src/cloudflare.ts`
- Raw-SQL projection read model: `samples/webApi/expressjs-with-sqlite/src/shoppingCarts/getShortInfo/index.ts`
- Domain (events/evolve/state): `samples/webApi/expressjs-with-sqlite/src/shoppingCarts/shoppingCart.ts`
- Commands/decide: `samples/webApi/expressjs-with-sqlite/src/shoppingCarts/businessLogic.ts`
- BDD test: `samples/webApi/expressjs-with-sqlite/src/shoppingCarts/businessLogic.unit.spec.ts`
- Hono wiring + helpers: `src/packages/emmett-honojs/src/e2e/decider/api.ts`, `src/packages/emmett-honojs/src/handler.ts`, `src/packages/emmett-honojs/src/application.ts`

## Risks — verified early by task order

1. **Task 2 spike (biggest unknown):** full emmett stack inside workerd under `wrangler dev` (driver is proven under Node+Miniflare, not in-workerd) + honojs barrel bundling under `nodejs_compat`. Fallback: plain Hono + copied error mapper. `npm run build` (deploy dry-run) makes this regression-checked on every commit.
2. Beta pinning — exact versions, no ranges. Peers installed explicitly: `hono`, `@hono/node-server`, `http-problem-details`, `@cloudflare/workers-types` (dev).
3. Projection init timing + `metadata.streamName` availability (read-model task; fallbacks defined above).
4. Non-interactive wrangler: `CI=true WRANGLER_SEND_METRICS=false`.

## Task checklist (each task = one commit; subagent marks `- [x]` in docs/plan/01-... before committing; pre-commit hook gives non-blocking build/test/lint feedback — RED tasks are expected to show failing tests, all other commits must be fully green)

- [x] **Task 1 — Plan + scaffold + tooling.** Clone emmett to `/root/patoarchitekci/emmett` (reference only). Save this plan as `docs/plan/01-podcast-cms-emmett-d1.md`. Add `package.json` (pinned emmett deps + hono; dev: `wrangler`, `@cloudflare/workers-types`, `typescript`, `tsx`, `@biomejs/biome`, `@hono/node-server`, `http-problem-details`; scripts per Tooling section), `tsconfig.json`, `wrangler.jsonc` (nodejs_compat, D1 binding `DB`), `biome.json`, `.claude/settings.json` (PostToolUse biome hook) + `scripts/biome-hook.sh`, `.githooks/pre-commit` (non-blocking feedback) + `git config core.hooksPath .githooks`, `.gitignore` += `.wrangler/` + `dist/`, minimal `src/index.ts` + `src/env.ts` with `GET /health`. *Verify:* `npm install`; `npm run build` green; `npx wrangler dev` + `curl :8787/health` → 200; editing a `.ts` file triggers biome hook; `git commit` prints hook feedback.
- [x] **Task 2 — De-risk spike: event store on local D1 in workerd.** `src/eventStore.ts` + store middleware; `/health` temporarily appends probe event + `aggregateStream`s it back (returns version); import an emmett-honojs root helper to prove bundling. Apply plain-Hono fallback in same task if needed, record deviation in plan doc. *Verify:* `curl /health` twice → version increments; restart `wrangler dev` → data persisted; `npm run build` green.
- [x] **Task 3 — Domain model + decider skeleton.** `src/episodes/episode.ts` (event types, metadata, state union, `episodeStreamId`; `evolve`/`initialState` stubs) + `src/episodes/businessLogic.ts` (command types, `decide` stub throwing `Not implemented`). *Verify:* `npm run build` green (no tests yet).
- [x] **Task 4 — RED: decider BDD specs.** `businessLogic.spec.ts` with `DeciderSpecification.for({ decide, evolve, initialState })`: create happy path; create-on-existing throws; partial content/distribution updates (only present keys in event); empty update throws `ValidationError`; update/publish on `NotCreated` throws; transcript review; **publish twice → two `EpisodePublished` events, `last_published_at` advances**; metadata (`user`/`reason`/`now`) stamped on events. *Verify:* `npm run typecheck` green; `npm test` **fails** (expected red — commit anyway, hook feedback shows it).
- [x] **Task 5 — GREEN: implement evolve + decide.** Fill in `evolve`, `initialState`, `decide` + metadata stamping helper. *Verify:* `npm test` fully green; `npm run build` green.
- [x] **Task 6 — RED: auth middleware specs.** `src/auth/permissions.ts` (map + `canAccess` stub) + `middleware.ts` (`requireAccess` stub) + `middleware.spec.ts` via `app.request()`: 404 unknown podcast / 401 no header / 401 unknown user / 403 no grant / 403 RO-on-RW / pass-through sets user. *Verify:* typecheck green; `npm test` red on auth specs only (decider specs stay green).
- [x] **Task 7 — GREEN: implement auth middleware.** Implement `canAccess` + `requireAccess` + `X-User`/`X-Reason` extraction per design. *Verify:* `npm test` fully green.
- [x] **Task 8 — Command endpoints.** 5 mutation routes in `src/episodes/api.ts` via `CommandHandler` + `requireAccess('RW')`; command metadata from headers; `STREAM_DOES_NOT_EXIST` on create; weak ETag via `toWeakETag()`; confirm problem-details statuses (map to 400/403/404/409 per design); remove Task-2 probe from `/health`. *Verify:* `npm run build` + curl cookbook — create 201, duplicate 409, patches 204, review/publish 204, RO 403, unknown user 401.
- [x] **Task 9 — GET episode state.** `aggregateStream`-backed GET route; `!streamExists` → 404; `requireAccess('RO')`. *Verify:* alice reads podcast-b (RO) → 200; missing episode → 404.
- [x] **Task 10 — History endpoint.** `src/episodes/history.ts` (replay + per-field diff) + GET route. *Verify:* curl after Task-8 sequence shows per-event user/reason/timestamp/type + correct before/after, incl. two publish entries.
- [x] **Task 11 — Read model + list endpoint.** `src/episodes/readModel.ts` (`sqliteRawSQLProjection`), register in `eventStore.ts` `projections.inline`, ensure table creation (bootstrap fallback if needed), GET list via `env.DB` direct query. Reset `.wrangler/state`; note no-backfill caveat. *Verify:* 2 episodes in podcast-a + 1 in podcast-b, one published → correct per-podcast lists incl. `last_published_at`.
- [x] **Task 12 — README + docs.** Setup (`npm install`, `npm run dev`), tooling notes (biome hook, non-blocking pre-commit, red-green flow), curl cookbook, auth matrix, event catalog + property-sourcing rationale, `X-Reason` note, history sample output, future deploy steps (`wrangler deploy`, remote D1 migrations). Final checklist sweep. *Verify:* follow README on clean checkout (`rm -rf node_modules .wrangler dist`).

## Verification (end-to-end commands)

```bash
npm install
npm test                        # BDD decider + auth middleware specs (node --import tsx --test)
npm run build                   # tsc --noEmit + wrangler deploy --dry-run (bundle proof)
CI=true WRANGLER_SEND_METRICS=false npx wrangler dev   # http://localhost:8787

# happy path (alice = RW on podcast-a)
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes \
  -H 'X-User: alice' -H 'X-Reason: initial import' -H 'Content-Type: application/json' \
  -d '{"episode_number": 42, "title": "Event Sourcing 101", "episode_date": "2026-07-01"}'   # 201
curl -i -X PATCH localhost:8787/podcasts/podcast-a/episodes/42/content \
  -H 'X-User: alice' -H 'X-Reason: added transcript' -H 'Content-Type: application/json' \
  -d '{"transcript": "hello...", "duration_ms": 3600000}'                                     # 204
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes/42/transcript/review -H 'X-User: alice'  # 204
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes/42/publish -H 'X-User: alice' \
  -H 'X-Reason: initial release'                                                              # 204
curl -i -X POST localhost:8787/podcasts/podcast-a/episodes/42/publish -H 'X-User: alice' \
  -H 'X-Reason: republish after fix'                                                          # 204 (repeatable)
curl -i -X PATCH localhost:8787/podcasts/podcast-a/episodes/42/distribution \
  -H 'X-User: alice' -H 'Content-Type: application/json' -d '{"spotify_id": "sp-123"}'        # 204

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

## Deviations log

- **Task 1:** `wrangler` pinned to `~4.107.1` (not latest). `wrangler@4.108.0` switched its `@cloudflare/workers-types` peer to `^5.x`, while `emmett-sqlite@0.43.0-beta.23` (and its deps `pongo`/`dumbo`) peer-require `^4.20260421.1` — unresolvable together. `4.107.1` is the last wrangler on the 4.x workers-types line; `@cloudflare/workers-types` pinned `^4.20260702.1` (highest existing 4.x). Emmett packages installed at the planned `0.43.0-beta.23` exactly.
- **Task 1:** local port 8787 is occupied by an unrelated daemon in this environment; dev-server verification used `wrangler dev --port 8788`.
- **Task 4:** added `@types/node` devDependency + `"node"` in tsconfig `types` — required for `node:test`/`node:assert` typings in spec files (Task 1 devDeps list missed it; runner already was `node --test`).
- **Task 5:** `npm run lint` was failing before any code change: `@biomejs/biome` is declared as `^2.3.3`, npm installed 2.5.3, and `biome.json` still declared the 2.3.3 schema — the version mismatch itself is a lint error. Fixed with `npx biome migrate --write` (schema bumped to 2.5.3, deprecated `rules.recommended` → `rules.preset`). No rule behavior changed.
- **Task 8:** error mapping uses the pre-approved plain `app.onError` mapper in `src/index.ts` instead of `getApplication`'s problem-details middleware (the app is a typed plain `Hono` with Bindings/Variables, which `getApplication` doesn't compose with). It reuses `defaultErrorToProblemDetailsMapping` from emmett-honojs; confirmed defaults: ValidationError→400, IllegalStateError→403, NotFoundError→404 match the plan, but version conflicts default to **412** (`EmmettError.Codes.ConcurrencyError`) — remapped to **409** via `isExpectedVersionConflictError` per the plan's duplicate-create contract.
- **Task 11:** both open questions resolved on the happy path — `metadata.streamName` IS available in inline projection handlers (append sets it on every recorded message before `onBeforeCommit`), so no `podcast_id`-in-event fallback was needed; projection `init` SQL runs on every `schema.migrate()` (via `createEventStoreSchema`'s `onBeforeSchemaCreated` hook), so no bootstrap `CREATE TABLE` was needed. Two implementation notes: (1) `SQL` tagged template imported from `@event-driven-io/dumbo` (parameterized SQL; transitive dep pinned exactly via emmett-sqlite — same phantom-dep practice as emmett's own sqlite sample); (2) `EpisodeContentUpdated` maps to a single `UPDATE ... SET title = COALESCE(?, title), episode_date = COALESCE(?, episode_date)` instead of per-key statements — same "only present keys" semantics, but always emits one statement, avoiding `batchCommand([])` → D1 `batch([])` (undefined behavior) on patches that touch neither listed column (e.g. transcript-only).
- **Task 2:** the anticipated honojs-barrel risk did NOT materialize — `@event-driven-io/emmett-honojs` bundles fine under `nodejs_compat` (no fallback needed). An unanticipated bundling issue did: the `@event-driven-io/emmett-sqlite` root barrel transitively imports the optional native drivers `pg` and `sqlite3` (chain: emmett-sqlite index → pongo → dumbo/pg + dumbo/sqlite3), which are uninstalled optional peers, so `wrangler deploy --dry-run` failed to resolve them. Fix: `alias` in `wrangler.jsonc` maps `pg` and `sqlite3` to an empty stub module (`src/stubs/native-driver-stub.ts`). Safe because with the D1 driver those code paths are never executed — module init in dumbo's pg/sqlite3 files only registers driver descriptor objects; the native imports are referenced solely inside functions.
