# 2026-07-09 — Oskar Dudycz — code review notes & reading list

Collected feedback from Oskar's review of `scratchpad-cms` (commit `e57aec7`).
This is a **reference document only** — no plan, no tasks. Just the remarks
grouped by topic, anchored to the code, plus the materials Oskar pointed to.

Overall verdict (Oskar): *"I rate this result as the creation of a repo
template — now a human should step in and steer heavily."*
Context note (kaluzaaa): **D1 is already mandated** for this project.

---

## 1. Testing — use Emmett's API tests instead of hand-rolled specs

**Remark:** Why not use the API tests from Emmett? They'd let you work much more
**outside-in**.

**Anchored to:** `src/auth/middleware.spec.ts` — currently a hand-built Hono app
+ manual `app.request()` + custom `assertProblem` helper.

**What to consider:**
- Emmett provides ready-made API test specifications; adopting them enables an
  outside-in style (drive behavior from the API surface, not the middleware
  internals).
- Two flavors offered:
  - **E2E API spec** (black-box, through the HTTP surface):
    `apiE2ESpecification.int.spec.ts`
  - **Event-first API spec** (given events → when request → then events):
    `apiSpecification.int.spec.ts`

**Materials:**
- E2E API spec example:
  https://github.com/event-driven-io/emmett/blob/main/src/packages/emmett-honojs/src/testing/apiE2ESpecification.int.spec.ts
- Event-first API spec example:
  https://github.com/event-driven-io/emmett/blob/main/src/packages/emmett-honojs/src/testing/apiSpecification.int.spec.ts
- Article — *Testing Event Sourcing, Emmett edition*:
  https://event-driven.io/en/testing_event_sourcing_emmett_edition/
- Current file under review:
  https://github.com/kaluzaaa/scratchpad-cms/blob/main/src/auth/middleware.spec.ts

---

## 2. Event metadata — avoid unnecessary metadata; `reason` is a smell here

**Remark 1 (`reason`):** What is `reason`? I wouldn't put it here now — it's
already in the saved message. In general I'd avoid metadata unless it's
genuinely additionally needed; it's a slight smell. (*"user is ok — I should
probably eventually extend Emmett with it."*)

**Anchored to:** `src/episodes/businessLogic.ts:68` (`stampMetadata`) and
`src/episodes/episode.ts:7-11` (`EpisodeEventMetadata` = `user`, `reason?`,
`now`).

**Remark 2 (empty event data):** The empty data is very suspicious — there's no
data at all, e.g. *who did it*.

**Anchored to:** `src/episodes/businessLogic.ts:121` — `TranscriptReviewed`
emits `data: {}`. See also `episode.ts:81-85` (`TranscriptReviewed` typed as
`Record<string, never>`).

**What to consider:**
- `user` in metadata is acceptable, but `reason` probably shouldn't ride along
  as metadata when it's already carried by the message.
- An event with completely empty `data` is a modeling smell — capture the
  meaningful facts (who/what) in the event's own data rather than leaning on
  metadata or emitting nothing.
- Related: the debate about putting `streamId` (identity) into event data vs.
  deriving it — relevant because the read model reconstructs `podcastId` /
  `episode_number` from the stream id (`readModel.ts:34-39`,
  `parseEpisodeStreamId`).

**Materials:**
- Article — *On putting stream id in event data*:
  https://event-driven.io/en/on_putting_stream_id_in_event_data/
- Article — *Using event metadata in event-driven projections*:
  https://event-driven.io/en/projections_and_event_metadata/

---

## 3. Event modeling — don't split field groups for reuse

**Remark:** These events are weird — why split `EpisodeCreationFields`,
`EpisodeDistributionFields`, `EpisodeContentFields`? To reuse them across
commands? I wouldn't do such tricks — these are unnecessary optimizations,
especially with LLMs; eventually as the app evolves the LLM will just change
both places at once anyway.

**Anchored to:** `src/episodes/episode.ts:13-67` — the three shared field-group
types plus the `EPISODE_*_FIELD_KEYS` whitelists, reused across events, commands
(`businessLogic.ts:20-48`), and state (`episode.ts:110-119`).

**What to consider:**
- The DRY-across-events/commands sharing is premature optimization here. Prefer
  events (and their data) that stand on their own, even at the cost of some
  duplication.
- Especially avoid this kind of indirection when the code is LLM-maintained.

**Materials:**
- File under review:
  https://github.com/kaluzaaa/scratchpad-cms/blob/main/src/episodes/episode.ts

---

## 4. Aggregate modeling — introduce a "draft" concept

**Remark:** Longer-term, from a modeling standpoint, think about whether
`EpisodeCreated` (and the entity) should distinguish the notion of a **"draft"**.

**Anchored to:** `src/episodes/episode.ts` — currently `Episode` is
`NotCreated | Created` (`episode.ts:110-119`); no explicit draft phase.
`EpisodeCreated` (`episode.ts:69-73`) collapses creation and the working state.

**What to consider:**
- A distinct "draft" state/event may model the lifecycle better than a single
  `Created` status carrying everything.
- This is the "slim down your aggregate" idea — split lifecycle phases into
  their own types instead of one fat aggregate.

**Materials:**
- `slim-down-your-aggregate` — book aggregate:
  https://github.com/oskardudycz/slim-down-your-aggregate/blob/main/node.js/src/slimmed/domain/books/book.ts
- `slim-down-your-aggregate` — draft phase:
  https://github.com/oskardudycz/slim-down-your-aggregate/blob/main/node.js/src/slimmed/domain/books/draft/index.ts
- Talk (Wrocław JUG, Java version) — *Odchudź swoje agregaty!*:
  https://www.youtube.com/watch?v=UVsen5qKQoM

---

## 5. Persistence / read model — consider Pongo

**Remark:** Out of curiosity — are you deliberately not using Pongo?
Follow-ups: Pongo also runs on D1. Unless you specifically want plain tables
that's fine, but with Pongo you'd do less work.

**Anchored to:** `src/episodes/readModel.ts` — hand-written `CREATE TABLE` +
raw `SQL` INSERT/UPDATE projection via `sqliteRawSQLProjection`.

**What to consider:**
- Pongo (document API over SQLite/Postgres/D1) could replace the raw-SQL read
  model and reduce boilerplate.
- Decision point: plain relational tables (current) vs. Pongo document store.
  D1 is already required for the project, and Pongo supports D1 — so the D1
  constraint does **not** rule Pongo out.

**Materials:**
- File under review:
  https://github.com/kaluzaaa/scratchpad-cms/blob/main/src/episodes/readModel.ts

---

## Consolidated reading list

| # | Type    | Topic                                   | Link |
|---|---------|-----------------------------------------|------|
| 1 | Article | Testing Event Sourcing (Emmett edition) | https://event-driven.io/en/testing_event_sourcing_emmett_edition/ |
| 2 | Article | Stream id in event data                 | https://event-driven.io/en/on_putting_stream_id_in_event_data/ |
| 3 | Article | Event metadata in projections           | https://event-driven.io/en/projections_and_event_metadata/ |
| 4 | Code    | Emmett E2E API spec example             | https://github.com/event-driven-io/emmett/blob/main/src/packages/emmett-honojs/src/testing/apiE2ESpecification.int.spec.ts |
| 5 | Code    | Emmett event-first API spec example     | https://github.com/event-driven-io/emmett/blob/main/src/packages/emmett-honojs/src/testing/apiSpecification.int.spec.ts |
| 6 | Code    | slim-down-your-aggregate — book         | https://github.com/oskardudycz/slim-down-your-aggregate/blob/main/node.js/src/slimmed/domain/books/book.ts |
| 7 | Code    | slim-down-your-aggregate — draft        | https://github.com/oskardudycz/slim-down-your-aggregate/blob/main/node.js/src/slimmed/domain/books/draft/index.ts |
| 8 | Video   | Odchudź swoje agregaty! (Wrocław JUG)    | https://www.youtube.com/watch?v=UVsen5qKQoM |

Extra book Oskar recommends in the talk: *Domain Modeling Made Functional*
(Scott Wlaschin). His reference repo: **`slim aggregate`** on his GitHub (C#,
TypeScript, Java in progress).

---

# Conclusions after reading all the materials

Synthesis of the three articles, the Emmett/slim-aggregate source, and the full
talk transcript. Grouped by decision, each tied to our code. **Still no plan —
these are conclusions to weigh, not tasks.**

## A. What an aggregate is actually for (the talk's core thesis)

- An aggregate is **a pattern to guard consistency** (business + transactional).
  The name is **not** "aggregate all the data into one object" — it means *all
  data that must change together changes together*, as one business transaction.
- Aggregate/write-model state should hold **only what's needed to verify
  invariants** (the fields your `if`s actually read) — **not** data you keep just
  to display or return. Fat state that mirrors the DB row is the anti-pattern.
- The leak usually comes from the ORM forcing public getters/setters, so the
  "protected domain" quietly takes its shape from the table, not the rules.

**Applies to us:** our `Episode` "Created" state currently carries the *full*
content + distribution field set (`episode.ts:110-119`) even though almost none
of those fields gate an invariant. The decide functions only branch on `status`
(`ensureCreated`) and emptiness (`ensureNotEmpty`) — see `businessLogic.ts`. So
most of that state is display data living in the write model.

## B. Oskar's 4-step refactor (the recipe from the talk)

1. **Check your IFs.** Delete every getter/field not read by a business rule.
2. **Do you even need the data?** e.g. a full list collapses to a *count* if the
   only rule is on its size. (For us: do we need full `transcript`/`newsletter`/
   `meta_seo` in the aggregate, or just flags like `transcript_reviewed`?)
3. **Introduce events in every method** — a sealed/`marker interface` union of
   granular events stating exactly what changed. (We already have this shape:
   `EpisodeEvent` union in `episode.ts:99-104`.) ✅ mostly done.
4. **Apply events to evolve state precisely** instead of ORM full-object updates.
   (We already have `evolve` + a raw-SQL projection doing granular updates.) ✅

**Where we already are:** we're event-first with `decide`/`evolve` — so steps 3–4
are largely done. The unfinished part is **steps 1–2**: the `Created` state is
still fat with display fields.

## C. The "Draft" question — resolved

Oskar's review asked us to consider a **Draft** concept. Two data points that
look contradictory but aren't:

- The **talk** presents per-state types (Draft / Editing / InPrint / Published,
  each an immutable record with only its own fields + `handle(state, cmd)=>event`
  guarded by `ofType`) as the **final, most radical, explicitly optional** step —
  *"zdecydowanie powyżej progu"*. Introduced to **host phase-specific invariants**
  and make illegal states unrepresentable — **not for tidiness**.
- The **slim-aggregate repo** (`book.ts` + `draft/`) is exactly that end-state
  fully built out: a discriminated union of phase types, per-phase `evolve` +
  guards, and the root `evolve` declaring transitions via `initialDraft` etc.

**Conclusion:** introduce an `EpisodeDraft` phase **only if it hosts a real rule**
that differs between draft and published (e.g. "cannot publish without
transcript/audio/metadata"). If our only publish rule stays trivial, the current
`NotCreated | Created` marker is already the pattern Oskar endorses — the
boolean-marker form is *fine*. Decide by counting the invariants that actually
differ per phase, not by aesthetics. This directly reframes review item **#4**.

## D. Metadata & event data (articles 2 + 3) — the firmest recommendations

- **`reason` in metadata** — likely wrong. Metadata = ambient request/auth
  context (`user`, `now` ✅). `reason` is *semantic input to the decision*, not
  ambient — per the metadata article it belongs in the event **data** (or nowhere).
  This confirms review item **#2**.
- **Parsing the stream id in the projection** (`parseEpisodeStreamId` in
  `readModel.ts`) is the exact anti-pattern of article 2. `podcastId` and
  `episode_number` should be **explicit in event data** and the projection should
  read `event.data.*`, not reverse-engineer the stream id string. This is the
  most concrete, lowest-controversy fix on the list.
- Note the empty `TranscriptReviewed` `data: {}` — under-specified per both
  articles (no business identifiers / no "who/what"). Confirms review item **#2**.

## E. Testing (article 1 + Emmett source) — clear migration target

- Replace hand-written Hono tests with Emmett's layered specs, all `given/when/then`:
  - **`DeciderSpecification`** for pure business rules: `given(events).when(cmd)
    .then([events])` / `.thenThrows(...)`. Fast, precise — ideal for our `decide`.
  - **`ApiSpecification`** for endpoint wiring incl. problem+json:
    `existingStream(id, events)` → request → `expectResponse` / `expectNewEvents`
    / `expectError(status, problemDetails)`. `expectError` maps 1:1 onto the
    problem+json contract we just built (Tasks 3/4) and replaces our custom
    `assertProblem` helper.
  - **`ApiE2ESpecification`** (arrange *and* act via real HTTP) for a thin
    auth/middleware smoke layer — the right fit for `middleware.spec.ts`, since
    auth is a pipeline concern, not an event outcome. Confirms review item **#1**.

## F. Pongo (persistence) — decision unblocked, path verified

From the review thread: **Pongo runs on D1** — and a follow-up research pass
**confirmed it against the actual source** (not just the claim). Key facts:

- Pongo ships a real **Cloudflare D1 driver**: `@event-driven-io/pongo/cloudflare`
  exports `d1Driver`. Setup: `pongoClient({ driver: d1Driver, database: env.DB,
  transactionOptions: { mode: 'session_based' } })`. No TCP, pure D1 binding.
- **Emmett already has ready-made Pongo projection helpers for SQLite/D1** in
  `@event-driven-io/emmett-sqlite`: `pongoSingleStreamProjection`,
  `pongoMultiStreamProjection`, `pongoProjection` — mirroring the Postgres API.
  We would NOT hand-write `updateOne` calls, and the helper **auto-creates the
  collection table** (`collection.schema.migrate()` in its `init`) — so the
  `CREATE TABLE` + `ON CONFLICT` in `readModel.ts` disappears entirely.
- Event store wiring: `getSQLiteEventStore({ driver: d1EventStoreDriver,
  database: env.DB, projections: [{ type: 'inline', projection: episodesProjection }] })`.
- Our `episodes_list` raw-SQL projection maps directly to a
  `pongoSingleStreamProjection<EpisodeDocument, EpisodeEvent>({ collectionName:
  'episodes', canHandle: [...], evolve, initialState })` where `_id` defaults to
  the stream name (= our old `stream_id` PK) and `evolve` is a plain
  document-in/document-out reducer — no SQL.

**Two loud caveats:**
1. **Everything is beta** — pongo `0.17.0-beta.40`, dumbo `0.13.0-beta.40`,
   emmett-sqlite `0.43.0-beta.23`. Pin exact versions; API names may shift.
2. **D1 has no real SQL transactions** (no BEGIN/COMMIT/SAVEPOINT). The driver
   requires `mode: 'session_based'`, which simulates atomicity via D1's
   session/batch API — atomicity holds only *within a single batch*, not across
   statements. Deliberate tradeoff by Oskar (article: *Cloudflare D1
   transactions and tradeoffs*). This constraint applies to the raw-SQL approach
   too, so it's not a Pongo-specific regression.

**Bonus:** adopting Pongo also removes the review's #2 pain point — with a
document read model there's no `parseEpisodeStreamId` string-splitting; you read
`event.data.podcastId` / `episodeNumber` into the document fields (which still
requires putting them into event data per item D).

Open decision: plain relational read model (current) vs. Pongo document store —
now a genuine, low-friction option since D1 + Emmett support is first-class.
Weigh when we touch the read model. Review item **#5**.

Sources: pongo & emmett repos (`/cloudflare` drivers, `pongoProjections.ts`,
D1 e2e specs); https://event-driven.io/en/cloudflare_d1_transactions_and_tradeoffs/ ;
https://event-driven-io.github.io/Pongo/getting-started.html

## Priority read (if picking where to start)

By confidence/impact, lowest-risk first:
1. **Stream id → event data** (D/anti-pattern, mechanical, high certainty).
2. **`reason` out of metadata** (D, clear per article 3).
3. **Slim the `Created` state** — steps 1–2 of the recipe (B).
4. **Emmett test specs** (E) — improves everything downstream.
5. **Draft phase** — only if invariants justify it (C).
6. **Pongo** — only when reworking the read model (F).

---

# Decision log — domain conversation (2026-07-09)

Facts and decisions gathered from the owner; these settle several review items.

## Domain facts

- **Transcript flow (two-stage, external via HappyScribe):**
  1. draft transcript is retrieved and imported first;
  2. after the proofreader's email, an agent triggers retrieval of the
     **reviewed** version, which **overwrites the same field** (one field,
     last-write-wins; the draft remains recoverable from event history).
- **Episode lifecycle:** create → fill in → **publish** → post-publish edits
  (platform ids: Spotify/Apple/YT/Spreaker, newsletter) → **republish** (loop:
  website settings + hosting platform).
- **Publication required fields:** episode number, date, spreaker id, intro.
- **Reviewed transcript is NOT a gate for publishing the episode** — without a
  reviewed version the episode publishes but the *transcript itself* is not
  published/included.
- **Republication = the same `EpisodePublished` repeated** (not a separate
  event); it triggers downstream platform calls which are **idempotent**.
- **`is_published` is the phase marker**; in the web API `is_published` and
  `transcript` are **read-only** fields (written only by the system/integrations,
  never by API clients).

## Decisions

- **No separate `Draft | Published` state types** — `is_published` boolean marker
  suffices (the form Oskar endorses when phase invariants are few). The
  publication invariant (required fields) lives in `decide` for `PublishEpisode`.
- **Transcript events:** two milestones → two events (option A):
  `TranscriptDraftImported` / `ReviewedTranscriptImported`, both carrying real
  data (podcastId, episodeNumber, happyScribeJobId, transcript ref, trigger
  source). Replaces the empty-data `TranscriptReviewed`.
- **Aggregate stays slim:** no transcript content in the write model — only
  presence flags read by invariants (e.g. `hasReviewedTranscript` gates
  *transcript* publication, not episode publication).
- **Read model holds the full, latest transcript** (single overwritten field).

## Decisions round 2 (2026-07-09, later)

1. **Publication invariant: hard gate + advisory readiness query.** `decide`
   throws on `PublishEpisode` when required fields (episode number, date,
   spreaker id, intro) are missing. Separately, a readiness check (the old
   `check_publication_readiness` idea — not built here yet) is an advisory
   query for agents/humans, callable on any episode; it must **reuse the same
   predicate** (`requiredForPublication(state)`) so the two can't drift.
2. **`published_at`:** the publish API is invoked via RPC, so the timestamp is
   generated **server-side at the endpoint/handler** and passed into `decide`
   as command **data** (keeps `decide` pure and testable). Not taken from
   event metadata (`now` is being removed). Each republication (same
   `EpisodePublished`, idempotent downstream) stamps a fresh `published_at`;
   the store's recorded timestamp remains for audit.
3. **Pongo on D1 — DECIDED, we migrate.** Read model moves from
   `sqliteRawSQLProjection` + hand-written SQL to
   `pongoSingleStreamProjection` (section F). Pin exact beta versions.
4. **Field groups — direction: inline per event/command.** Delete the shared
   `EpisodeCreationFields` / `EpisodeContentFields` /
   `EpisodeDistributionFields` types; each event and command declares its own
   payload explicitly, duplication accepted (Oskar: LLMs update both sides
   anyway). The runtime API-body whitelists move next to the routes that use
   them, as plain consts.
5. **`reason` — KEPT, consciously, as optional metadata.** Its purpose is an
   agent-supplied audit annotation ("why did this happen"), arriving via the
   `X-Reason` header — i.e. request context, the same category as `user`
   (passes the endpoint test from the metadata article). Not a business fact,
   so not event data. Oskar's own caveat: user-style audit metadata is ok.

## Still open

- **Procedural only:** convert these notes into `docs/plan/XX-*.md` with a
  per-task checklist (repo rule), and pick the implementation order. All
  domain/design questions from the review are now resolved.
