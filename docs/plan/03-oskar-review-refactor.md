# Plan 03 — Apply Oskar's review decisions

## Context

Oskar Dudycz reviewed the repo (commit `e57aec7`) and raised 7 issues. Every
issue was researched (3 articles, Emmett/slim-aggregate sources, full talk
transcript) and every design question was resolved with the owner. The full
decision log lives in `docs/review/2026-07-09-oskar-review-notes.md`. This plan turns
those decisions into code, one commit per task, on branch
`refactor/oskar-review`, finished with a GitHub PR to `main`.

**Workflow:** Task 1 commits this plan, pushes, and opens a **draft PR**
immediately → Tasks 2–9: one commit each, pushed right after committing (the
draft PR updates live) → Task 10 finalizes the PR body with the traceability
table and marks it ready for review.

Key facts that shape task order:
- `src/episodes/history.ts` uses `event.metadata.now` as the audit timestamp
  → removing `now` (Task 3) must switch history to the store's recorded time.
- `GET /episodes/:n` serves **aggregate state** via `aggregateStream` → the
  aggregate cannot be slimmed (Task 8) until the Pongo read model (Task 6) can
  serve full episode data.
- `businessLogic.spec.ts` already uses `DeciderSpecification` — review item #1
  only lacks the HTTP-layer `ApiSpecification` tests.
- Pongo `0.17.0-beta.40` is already a transitive dep of
  `@event-driven-io/emmett-sqlite@0.43.0-beta.23`.

---

## Tasks

### Task 1 — Commit this plan + open draft PR
Branch `refactor/oskar-review`; add this plan; date the review-notes title
(`# 2026-07-09 — Oskar Dudycz — …`). Commit, push (`-u origin`), open a draft
PR (`gh pr create --draft`) linking this plan and the review notes.

### Task 2 — Explicit ids in event data (kill `parseEpisodeStreamId`)
**Rationale (review #4-adjacent, stream-id article):** projections must not
reverse-engineer business ids from the stream-id string; ids belong explicitly
in event data.
- `src/episodes/episode.ts`: add `podcast_id: string` to `EpisodeCreated` data
  (`episode_number` is already there). Delete `parseEpisodeStreamId`.
- `src/episodes/api.ts` (POST create): put `podcast_id` (route param) into the
  `CreateEpisode` command data.
- `src/episodes/readModel.ts`: `EpisodeCreated` case reads
  `event.data.podcast_id`; `streamName` stays **only** as the opaque row key.
- Update `businessLogic.spec.ts` fixtures.
- Update/publish events do NOT get ids added — they only carry their facts;
  the new transcript events (Task 7) carry ids per the decision log.

**Modeled shape:**
```typescript
export type EpisodeCreated = Event<
  "EpisodeCreated",
  {
    podcast_id: string; // explicit business id, no longer derived from stream id
    episode_number: number;
    title: string;
    episode_date: string;
  },
  EpisodeEventMetadata
>;

// readModel.ts EpisodeCreated case — no parsing:
const { podcast_id, episode_number, title, episode_date } = event.data;
```
**Source:** https://event-driven.io/en/on_putting_stream_id_in_event_data/

### Task 3 — Metadata cleanup: drop `now`, keep `user` + optional `reason`
**Rationale (review #2):** the event store stamps recorded time itself — `now`
in metadata is a second source of truth (Oskar: "Now bym tutaj nie dawał, bo
jest już w zapisanej wiadomości"). `reason` stays **consciously**: an
agent-supplied audit annotation from `X-Reason` — request context, same
category as `user`. `published_at` is a business fact: generated server-side
at the endpoint (the API is invoked via RPC) and passed into `decide` as
command **data**, keeping `decide` pure.
- `src/episodes/episode.ts`: `EpisodeEventMetadata = { user: string; reason?: string }`.
- `src/episodes/businessLogic.ts`: `stampMetadata` simplifies; `PublishEpisode`
  command data becomes `{ published_at: string }`.
- `src/episodes/api.ts`: `commandMetadata` stops stamping `now`; publish route
  generates `published_at = new Date().toISOString()`.
- `src/episodes/history.ts`: `timestamp` switches to the store's recorded
  time. **Verify first** whether emmett-sqlite's `ReadEvent` metadata exposes
  it; if not, read the `created` column of the messages table; if neither
  works, STOP and surface — do not silently drop timestamps.
- Update both spec files.

**Modeled shape:**
```typescript
export type EpisodeEventMetadata = { user: string; reason?: string };

const stampMetadata = ({ user, reason }: EpisodeEventMetadata): EpisodeEventMetadata =>
  reason !== undefined ? { user, reason } : { user };

export type PublishEpisode = Command<
  "PublishEpisode",
  { published_at: string }, // server-generated business fact, NOT metadata
  EpisodeEventMetadata
>;
```
**Source:** https://event-driven.io/en/projections_and_event_metadata/
(the "endpoint test": metadata = request/auth context only).

### Task 4 — Inline field groups (delete shared Creation/Content/Distribution types)
**Rationale (review #3):** the publication invariant (number+date+spreaker+
intro) cuts across the three groups, proving the split matches reuse, not the
domain. Oskar: "nie robiłbym takich myków, to są niepotrzebne optymalizacje,
szczególnie w LLMach."
- `src/episodes/episode.ts`: each event declares its payload inline; state
  declares its own shape; delete the three shared `*Fields` types; move the
  `EPISODE_*_FIELD_KEYS` whitelists next to their only consumer: `api.ts`.
- `src/episodes/businessLogic.ts`: commands declare payloads inline.
- `src/episodes/history.ts`: `FIELDS` becomes an explicit literal list.
- Duplication between event/command/state field lists is accepted by design.

**Modeled shape:**
```typescript
// episode.ts — each event owns its payload inline:
export type EpisodeContentUpdated = Event<
  "EpisodeContentUpdated",
  Partial<{
    title: string; intro: string; transcript: string; episode_date: string;
    link_notes: string; newsletter: string; summarization: string;
    yt_chapters: string; meta_seo: unknown; duration_ms: number;
  }>,
  EpisodeEventMetadata
>;
// (transcript key removed later by Task 7)

// api.ts — whitelist next to its only consumer, still type-checked:
const EPISODE_CONTENT_FIELD_KEYS = [
  "title", "intro", "transcript", "episode_date", "link_notes", "newsletter",
  "summarization", "yt_chapters", "meta_seo", "duration_ms",
] as const satisfies readonly (keyof EpisodeContentUpdated["data"] & string)[];
```

### Task 5 — Hard publication gate (`requiredForPublication`)
**Rationale (owner decision):** publish has required fields — episode number,
date, spreaker id, intro. `decide` **throws** when missing. A future readiness
check (advisory, for agents/humans) must reuse the same predicate — export it;
do NOT build the readiness endpoint now (YAGNI).
- `src/episodes/businessLogic.ts`: export
  `requiredForPublication(state): string[]`; `PublishEpisode` throws
  `ValidationError` listing missing fields (→ 400 problem+json).
- The fat state still has the fields here; Task 8 flips the predicate to flags
  without changing its contract.
- Republication stays repeatable (same event; downstream platforms idempotent).
- Specs for blocked/allowed publish; README documents the 400.

**Modeled shape:**
```typescript
export const requiredForPublication = (state: Episode): string[] =>
  state.status !== "Created"
    ? ["episode"]
    : [
        !state.episode_number && "episode_number",
        !state.episode_date && "episode_date",
        !state.intro && "intro",             // Task 8: !state.has_intro
        !state.spreaker_id && "spreaker_id", // Task 8: !state.has_spreaker_id
      ].filter((f): f is string => Boolean(f));

case "PublishEpisode": {
  ensureCreated(state);
  const missing = requiredForPublication(state);
  if (missing.length > 0)
    throw new ValidationError(
      `Cannot publish, missing required fields: ${missing.join(", ")}`,
    );
  return {
    type: "EpisodePublished",
    data: { published_at: data.published_at },
    metadata: stampMetadata(metadata),
  };
}
```

### Task 6 — Migrate read model to Pongo on D1
**Rationale (review #6, owner: "przechodzimy na Pongo"):** replace hand-written
`CREATE TABLE` + raw SQL projection with `pongoSingleStreamProjection`;
verified viable on D1 (notes §F).
- `package.json`: add `@event-driven-io/pongo` as a **direct** dep pinned to
  `0.17.0-beta.40` (the exact transitive version).
- `src/episodes/readModel.ts`: `pongoSingleStreamProjection<EpisodeDocument>` —
  document holds the **full** episode data; `_id` = stream name; plain
  doc-in/doc-out `evolve`. The document serves both GET endpoints.
- `src/episodes/api.ts`: GET list via Pongo `find({ podcast_id })`; GET single
  via `findOne({ _id: streamId })` (404 when null); ETag from doc `_version`.
- Local data reset (`rm -rf .wrangler/state`) acceptable — inline projections
  don't backfill.
- Verify `npm run build` (wrangler dry-run) with the direct pongo dep
  (`wrangler.jsonc` already stubs `pg`/`sqlite3`).

**Modeled shape (verified against pongo/emmett sources):**
```typescript
import { pongoSingleStreamProjection } from "@event-driven-io/emmett-sqlite";

export type EpisodeDocument = {
  _id: string; // = stream name (helper default)
  podcast_id: string;
  episode_number: number;
  title: string;
  episode_date: string;
  // full content + distribution fields (intro, transcript, newsletter, ...)
  is_published: boolean;
  transcript_reviewed: boolean;
  last_published_at?: string;
};

export const episodesProjection = pongoSingleStreamProjection<EpisodeDocument, EpisodeEvent>({
  collectionName: "episodes",
  canHandle: [/* ALL episode event types */],
  evolve: evolveDocument,
  initialState: () => ({ /* empty document */ }),
});

// api.ts — query-side client (memoize like getEventStore):
import { pongoClient } from "@event-driven-io/pongo";
import { d1Driver } from "@event-driven-io/pongo/cloudflare";
const pongo = pongoClient({
  driver: d1Driver,
  database: c.env.DB,
  transactionOptions: { mode: "session_based" }, // REQUIRED on D1
});
```
Implementation facts (do not rediscover):
- The projection helper reuses the event store's own connection (inline
  consistency); its `init` calls `collection.schema.migrate()` — table
  auto-created, no DDL.
- Returning `null` from `evolve` deletes the document.
- Public export is `d1Driver` (alias of internal `d1PongoDriver`).

**Sources:** Pongo repo `src/packages/pongo/src/e2e/sqlite/d1/d1.e2e.spec.ts`;
emmett repo `src/packages/emmett-sqlite/src/eventStore/projections/pongo/pongoProjections.ts`;
https://event-driven.io/en/cloudflare_d1_transactions_and_tradeoffs/ ;
https://event-driven-io.github.io/Pongo/getting-started.html

### Task 7 — Two-stage transcript import (replaces empty `TranscriptReviewed`)
**Rationale (review #2 empty-data + domain):** the real process is HappyScribe
draft import → proofreader email → reviewed import **overwriting the same
field**; without a reviewed version the transcript is not published, but the
episode still can be. Events are milestones and carry real data — no more
`data: {}`.
- Replace `ReviewTranscript`/`TranscriptReviewed` with
  `ImportTranscriptDraft` → `TranscriptDraftImported` and
  `ImportReviewedTranscript` → `ReviewedTranscriptImported`, both with data
  `{ podcast_id, episode_number, transcript }`. State keeps the
  `transcript_reviewed` flag (set by the reviewed import).
- Routes `POST .../transcript/draft` and `POST .../transcript/reviewed`
  (body `{ transcript }`, non-empty string) replace
  `POST .../transcript/review`; **remove `transcript` from the content PATCH
  whitelist** (read-only in the general API — written only via import routes).
- Read model: both events overwrite the document `transcript` field
  (last-write-wins → GET always serves the newest).
- No HappyScribe job ids yet (YAGNI — no integration in this repo; event
  history preserves both versions anyway).
- Specs + README.

**Modeled shape:**
```typescript
export type TranscriptDraftImported = Event<
  "TranscriptDraftImported",
  { podcast_id: string; episode_number: number; transcript: string },
  EpisodeEventMetadata
>;
export type ReviewedTranscriptImported = Event<
  "ReviewedTranscriptImported",
  { podcast_id: string; episode_number: number; transcript: string },
  EpisodeEventMetadata
>;

// aggregate evolve:
case "TranscriptDraftImported":    return state;                                   // no invariant touched
case "ReviewedTranscriptImported": return { ...state, transcript_reviewed: true }; // milestone flag

// read-model document evolve — ONE field, last-write-wins:
case "TranscriptDraftImported":
case "ReviewedTranscriptImported":
  return { ...doc, transcript: data.transcript };
```

### Task 8 — Slim the aggregate ("check your IFs")
**Rationale (talk recipe steps 1–2 + owner decision: `is_published` boolean
marker, no separate Draft/Published types):** the write model keeps only what
invariants read; full data lives in events + the Pongo document.
- `src/episodes/episode.ts`: `Created` state slims to flags (see shape below);
  presence flags replace stored content (`has_intro` true when a non-empty
  `intro` was set, false when cleared; same for `spreaker_id`).
- `src/episodes/businessLogic.ts`: `requiredForPublication` reads the flags.
- `src/episodes/api.ts`: GET single already serves the Pongo document (Task 6).
- `src/episodes/history.ts`: `buildHistory` switches from the aggregate
  `evolve` to the read-model `evolveDocument` so the per-field audit diff keeps
  seeing full data. Aggregate stays slim; history is a read-side concern.
- Specs updated (decider states now slim).

**Modeled shape:**
```typescript
export type Episode =
  | { status: "NotCreated" }
  | {
      status: "Created";
      episode_number: number;   // read by requiredForPublication
      episode_date: string;     // read by requiredForPublication
      has_intro: boolean;       // presence flag replaces stored content
      has_spreaker_id: boolean; // presence flag replaces stored content
      is_published: boolean;    // the phase marker (owner: no Draft types)
      transcript_reviewed: boolean;
      last_published_at?: string;
    };

// evolve — flags only; handles set AND clear:
case "EpisodeContentUpdated": {
  if (state.status !== "Created") return state;
  return {
    ...state,
    episode_date: data.episode_date ?? state.episode_date,
    has_intro:
      data.intro !== undefined
        ? typeof data.intro === "string" && data.intro.length > 0
        : state.has_intro,
  };
}
```
**Sources:** the talk ("wywalić wszystko czego nie mamy w ifach") and
https://github.com/oskardudycz/slim-down-your-aggregate — pattern reference for
what we deliberately do NOT adopt: per-phase types are the talk's optional
final step, justified only by phase-specific invariants; the owner decided the
`is_published` boolean marker suffices (a form Oskar explicitly endorses in
the talk — `IsOpened`).

### Task 9 — Emmett `ApiSpecification` tests for the HTTP layer
**Rationale (review #1):** decider specs already exist; the HTTP layer is
hand-rolled. Add outside-in tests with Emmett's spec DSL.
- New `src/episodes/api.spec.ts`: `ApiSpecification.for(...)` with
  `getInMemoryEventStore()` and an app factory composing `episodesApi` + auth
  middleware + `problemDetailsOnError` (no Pongo projection in-memory —
  command routes only).
- Cover: create (201 + `expectNewEvents`), duplicate create →
  `expectError(409)`, content/distribution PATCH happy + empty-body 400,
  publish blocked (400, missing-fields detail) / allowed, transcript
  draft+reviewed imports, auth contract via `expectError(401/403/404, ...)`.
- `src/auth/middleware.spec.ts`: keep `canAccess` unit tests; trim HTTP-error
  duplicates covered by `api.spec.ts`.
- If `ApiSpecification`'s request runner doesn't compose with our app shape,
  fall back to the same given/when/then structure over `app.request()` —
  surface this in the commit message rather than forcing it.

**Modeled shape (verified against emmett's own int specs):**
```typescript
const given = ApiSpecification.for<EpisodeEvent>(
  () => getInMemoryEventStore(),
  (eventStore) => buildTestApp(eventStore),
);

given(existingStream<EpisodeEvent>(streamId, [episodeCreated()]))
  .when((request) =>
    request
      .post(`/podcasts/podcast-a/episodes/1/publish`)
      .set({ "X-User": "alice" }),
  )
  .then([
    expectError(400, {
      status: 400,
      title: "Bad Request",
      type: "about:blank",
      detail: "Cannot publish, missing required fields: intro, spreaker_id",
    }),
  ]);
```
**Sources (Oskar's review links):**
`emmett/src/packages/emmett-honojs/src/testing/apiSpecification.int.spec.ts`,
`.../apiE2ESpecification.int.spec.ts`;
https://event-driven.io/en/testing_event_sourcing_emmett_edition/

### Task 10 — Final docs pass + PR ready
- README: full API table refresh (routes, publish 400, transcript read-only),
  plans table row for 03.
- Verify the checklist below is fully `[x]`.
- Finalize the PR body with the traceability table below, explicitly calling
  out the two conscious divergences (`reason` kept; no Draft phase) with their
  rationale; `gh pr ready`.

---

## Traceability — Oskar's review comments ↔ this plan (1:1)

| Oskar's comment (verbatim gist) | Addressed by | How |
|---|---|---|
| 1. `middleware.spec.ts` — "czemu nie używasz testów API z Emmetta? Mógłbyś robić bardziej outside-in" | **Task 9** | HTTP layer moves to `ApiSpecification` given/when/then; `canAccess` stays a unit test; decider specs already used `DeciderSpecification` |
| 2a. `businessLogic.ts:68` — "Now bym tutaj nie dawał, bo jest już w zapisanej wiadomości" | **Task 3** | `now` removed from metadata; store's recorded time is the single truth; `published_at` becomes server-generated command **data** |
| 2b. "a co to jest reason? … unikać metadanych jeśli nie są potrzebne (user jest ok)" | **Task 3** — ⚠️ conscious divergence | `reason` KEPT deliberately: optional agent audit annotation from `X-Reason` (request context, same category as `user`, passes the endpoint test from Oskar's own metadata article) |
| 3. `episode.ts` — "czemu porozdzielał EpisodeCreationFields / DistributionFields / ContentFields? niepotrzebne optymalizacje" | **Task 4** | Shared field-group types deleted; every event/command declares its payload inline; whitelists become plain consts next to the routes |
| 4. `businessLogic.ts:121` — "te puste dane bardzo podejrzane, np. kto to zrobił" | **Task 7** + **Task 2** | Empty `TranscriptReviewed {}` replaced by two real-data events; "who" stays in `metadata.user` (Oskar: user is ok); `EpisodeCreated` carries `podcast_id`; `parseEpisodeStreamId` deleted |
| 5. `readModel.ts` — "celowo nie używasz Pongo?" (+ "Pongo działa też na D1") | **Task 6** | Read model migrates to `pongoSingleStreamProjection` on D1; raw SQL projection deleted |
| 6. Reading list (articles, slim-aggregate repo, talk) | done pre-plan | Researched; conclusions in `docs/review/2026-07-09-oskar-review-notes.md`; shaped Tasks 3, 5, 8, 9 |
| 7. "Zastanowiłbym się modelarsko nad EpisodeCreated — czy nie rozróżnić pojęcia draft" | **Task 8** — ⚠️ conscious divergence | No separate Draft phase types: per Oskar's own talk, a phase type is introduced only to host a phase-specific invariant; owner decided `is_published` marker suffices; publish invariant lands in `decide` (Task 5); aggregate slimmed per the talk's recipe |
| 8. "Oceniam to jako szablon repa — teraz powinien wejść człowiek i mocno sterować" | whole plan | The domain conversation (decision log) is exactly that steering; every task carries its rationale from it |

---

## Execution rules (from CLAUDE.md)

- Everything written in English; KISS, YAGNI, SRP, DRY; surgical changes only.
- Coding via subagent; each subagent gets these rules in its prompt.
- Before committing: mark the task `[x]` in this file and commit everything
  for that one task together.
- After every task commit: push to `origin` immediately.
- Each task: `npm test && npm run typecheck && npm run lint` must pass before
  commit.

## Verification (end-to-end)

1. Per task: `npm test`, `npm run typecheck`, `npm run lint`.
2. After Task 6 and Task 8: `npm run build` (wrangler dry-run).
3. Manual smoke after Task 8: `npm run dev` + create → patch content (no
   transcript key) → import draft transcript → import reviewed → publish
   (expect 400 before spreaker_id+intro set, 204 after) → GET single/list
   (served from Pongo, transcript = latest) → GET history (timestamps present,
   per-field diffs intact).
4. PR ready for review, suite green.

## Risks

- **History timestamp source** (Task 3): recorded-time exposure in
  emmett-sqlite read events is unverified — verify-first step with a stop
  condition.
- **Beta APIs** (pongo/dumbo/emmett-sqlite): pinned exact versions.
- **Local data wipe**: switching projections does not backfill — documented
  reset: `rm -rf .wrangler/state`.

## Reference materials (from Oskar)

| Topic | Source |
|---|---|
| Ids belong in event data | https://event-driven.io/en/on_putting_stream_id_in_event_data/ |
| Metadata vs data ("endpoint test") | https://event-driven.io/en/projections_and_event_metadata/ |
| Testing layers (Decider/Api/E2E specs) | https://event-driven.io/en/testing_event_sourcing_emmett_edition/ |
| Event-first API spec example | `event-driven-io/emmett` → `src/packages/emmett-honojs/src/testing/apiSpecification.int.spec.ts` |
| Black-box E2E API spec example | `event-driven-io/emmett` → `src/packages/emmett-honojs/src/testing/apiE2ESpecification.int.spec.ts` |
| Pongo D1 client setup (canonical) | `event-driven-io/Pongo` → `src/packages/pongo/src/e2e/sqlite/d1/d1.e2e.spec.ts` |
| Pongo projection helpers for SQLite/D1 | `event-driven-io/emmett` → `src/packages/emmett-sqlite/src/eventStore/projections/pongo/pongoProjections.ts` |
| D1 transaction tradeoffs (`session_based`) | https://event-driven.io/en/cloudflare_d1_transactions_and_tradeoffs/ |
| Pongo CRUD API | https://event-driven-io.github.io/Pongo/getting-started.html |
| Slim-aggregate pattern (and what we skip) | https://github.com/oskardudycz/slim-down-your-aggregate |
| Full research digests | `docs/review/2026-07-09-oskar-review-notes.md` |

---

## Checklist

- [x] Task 1: branch `refactor/oskar-review` + commit plan doc + push + open draft PR
- [x] Task 2: explicit `podcast_id` in `EpisodeCreated` data; delete `parseEpisodeStreamId`
- [x] Task 3: drop `now` from metadata; server-side `published_at` as command data; history uses recorded time
- [x] Task 4: inline event/command payloads; delete shared field-group types; whitelists move to `api.ts`
- [x] Task 5: hard publication gate — `requiredForPublication` + `ValidationError` on publish
- [x] Task 6: Pongo read model on D1 (`pongoSingleStreamProjection`); GET list/single served from Pongo
- [x] Task 7: two-stage transcript import events + routes; transcript removed from content PATCH
- [x] Task 8: slim aggregate to invariant flags; history switches to read-model evolve
- [x] Task 9: `ApiSpecification` HTTP-layer tests (`api.spec.ts`)
- [ ] Task 10: README refresh + finalize PR body (traceability table) + `gh pr ready`
