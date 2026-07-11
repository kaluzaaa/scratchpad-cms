import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { after, before, describe, it } from "node:test";
import { Miniflare } from "miniflare";
import app from "../index";
import { episodeStreamId } from "./episode";
import type { EpisodeDocument } from "./readModel";

/////////////////////////////////////////
////////// Miniflare-backed app
/////////////////////////////////////////

// Full-stack integration through REAL D1: the production app from src/index.ts
// (getEventStore middleware, D1 event store with the inline Pongo projection,
// episodesApi, problem+json error mapping) driven over a Miniflare D1 database
// passed as per-request env. Complements api.spec.ts, which covers the command
// routes over an in-memory store — here the D1-only paths run for real: the
// document read model behind the GETs and the history timestamps read from
// the store's messages table.
//
// Safe to import the real app despite its module-level store memoization:
// node --test isolates each spec file in its own process, and this file uses
// a single database for its whole lifetime.

let mf: Miniflare;
let database: D1Database;

before(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default {}",
    d1Databases: { DB: "test-db-id" },
  });
  database = await mf.getD1Database("DB");
});

after(async () => {
  await mf.dispose();
});

const request = (path: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(app.request(path, init, { DB: database }));

const asAlice = { "X-User": "alice" };

const send = (method: "POST" | "PATCH", path: string, body?: unknown) =>
  request(path, {
    method,
    headers:
      body === undefined
        ? asAlice
        : { ...asAlice, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = (path: string) => request(path, { headers: asAlice });

/////////////////////////////////////////
////////// Fixtures
/////////////////////////////////////////

// alice has RW on podcast-a (src/auth/permissions.ts).
const podcastId = "podcast-a";
const episodeNumber = 42;
const streamId = episodeStreamId(podcastId, episodeNumber);
const episodesPath = `/podcasts/${podcastId}/episodes`;
const episodePath = `${episodesPath}/${episodeNumber}`;

const creationBody = {
  episode_number: episodeNumber,
  title: "Event Sourcing 101",
  episode_date: "2026-07-01",
};
// Apostrophes on purpose: regression guard for the upstream bound-object-params
// quote-escaping fix (Pongo #192 / #191). They must survive the full
// event-at-rest -> readStream -> history path that used to corrupt them.
const updatedTitle = "Event Sourcing 101 (Director's cut)";
const reviewedTranscript = "Alice's reviewed transcript, isn't it...";

type ProblemBody = { status: number; detail: string };
// Over the wire the Pongo BigInt `_version` is serialized as a string.
type JsonDocument = EpisodeDocument & { _version: string };

const expectProblem = async (
  response: Response,
  status: number,
  detail?: string,
): Promise<ProblemBody> => {
  strictEqual(response.status, status);
  strictEqual(response.headers.get("content-type"), "application/problem+json");
  const body = (await response.json()) as ProblemBody;
  strictEqual(body.status, status);
  strictEqual(typeof body.detail, "string");
  if (detail !== undefined) strictEqual(body.detail, detail);
  return body;
};

/////////////////////////////////////////
////////// Specs (one journey, sequential its sharing the stream)
/////////////////////////////////////////

void describe("Episodes API over real D1 (Miniflare)", () => {
  void it("creates an episode: 201 with stream_id", async () => {
    const response = await send("POST", episodesPath, creationBody);

    strictEqual(response.status, 201);
    deepStrictEqual(await response.json(), { stream_id: streamId });
  });

  void it("blocks publish before ready: 400 problem+json listing missing fields (not a 409)", async () => {
    const response = await send("POST", `${episodePath}/publish`);

    // 400, NOT 409: regression guard for the upstream dumbo bug where the
    // batch no-changes error matched emmett's version-conflict predicate.
    notStrictEqual(response.status, 409);
    await expectProblem(
      response,
      400,
      "Cannot publish, missing required fields: intro, spreaker_id",
    );
  });

  void it("patches content and distribution: 204 each", async () => {
    const content = await send("PATCH", `${episodePath}/content`, {
      intro: "Welcome back!",
      title: updatedTitle,
    });
    strictEqual(content.status, 204);

    const distribution = await send("PATCH", `${episodePath}/distribution`, {
      spreaker_id: "spr-42",
    });
    strictEqual(distribution.status, 204);
  });

  void it("imports draft then reviewed transcript: 204 each, reviewed overwrites the same field", async () => {
    const draft = await send("POST", `${episodePath}/transcript/draft`, {
      transcript: "draft transcript...",
    });
    strictEqual(draft.status, 204);

    const reviewed = await send("POST", `${episodePath}/transcript/reviewed`, {
      transcript: reviewedTranscript,
    });
    strictEqual(reviewed.status, 204);

    const document = (await (await get(episodePath)).json()) as JsonDocument;
    strictEqual(document.transcript, reviewedTranscript);
    strictEqual(document.transcript_reviewed, true);
  });

  void it("publishes a ready episode: 204", async () => {
    const response = await send("POST", `${episodePath}/publish`);

    strictEqual(response.status, 204);
  });

  void it("lists episodes from the projected document, filtered by podcast", async () => {
    const response = await get(episodesPath);
    strictEqual(response.status, 200);

    const { episodes } = (await response.json()) as {
      episodes: JsonDocument[];
    };
    strictEqual(episodes.length, 1);

    const [document] = episodes;
    ok(document);
    strictEqual(document._id, streamId);
    strictEqual(document.podcast_id, podcastId);
    strictEqual(document.episode_number, episodeNumber);
    strictEqual(document.title, updatedTitle);
    strictEqual(document.intro, "Welcome back!");
    strictEqual(document.spreaker_id, "spr-42");
    strictEqual(document.transcript, reviewedTranscript);
    strictEqual(document.is_published, true);
    strictEqual(typeof document.last_published_at, "string");

    // The podcast_id filter works: podcast-b (alice has RO) has no episodes.
    const other = await get("/podcasts/podcast-b/episodes");
    strictEqual(other.status, 200);
    deepStrictEqual(await other.json(), { episodes: [] });
  });

  void it("serves a single episode with an ETag from the document version; unknown episode is 404", async () => {
    const response = await get(episodePath);
    strictEqual(response.status, 200);

    const document = (await response.json()) as JsonDocument;
    strictEqual(document._id, streamId);
    ok(/^\d+$/.test(document._version));
    strictEqual(response.headers.get("etag"), `W/"${document._version}"`);

    await expectProblem(await get(`${episodesPath}/999`), 404);
  });

  void it("rejects a duplicate create with 409 problem+json (genuine conflict)", async () => {
    const response = await send("POST", episodesPath, creationBody);

    await expectProblem(response, 409);
  });

  void it("serves history with per-field diffs and recorded timestamps", async () => {
    const response = await get(`${episodePath}/history`);
    strictEqual(response.status, 200);

    const { stream_id, entries } = (await response.json()) as {
      stream_id: string;
      entries: {
        type: string;
        user: string;
        timestamp: string | null;
        changes: { field: string; before: unknown; after: unknown }[];
      }[];
    };
    strictEqual(stream_id, streamId);
    deepStrictEqual(
      entries.map(({ type }) => type),
      [
        "EpisodeCreated",
        "EpisodeContentUpdated",
        "EpisodeDistributionUpdated",
        "TranscriptDraftImported",
        "ReviewedTranscriptImported",
        "EpisodePublished",
      ],
    );

    // Per-field diff: the content patch shows the title transition. The
    // apostrophe in the new title must arrive intact (regression guard for
    // the upstream quote-escaping fix, Pongo #192 / #191).
    const contentEntry = entries[1];
    ok(contentEntry);
    deepStrictEqual(
      contentEntry.changes.find(({ field }) => field === "title"),
      { field: "title", before: creationBody.title, after: updatedTitle },
    );

    // Same guard on the transcript path: the reviewed import diff carries
    // the apostrophes unchanged.
    const reviewedEntry = entries[4];
    ok(reviewedEntry);
    deepStrictEqual(
      reviewedEntry.changes.find(({ field }) => field === "transcript"),
      {
        field: "transcript",
        before: "draft transcript...",
        after: reviewedTranscript,
      },
    );

    // Recorded time comes from the store's messages table, not metadata.
    for (const entry of entries) {
      strictEqual(entry.user, "alice");
      strictEqual(typeof entry.timestamp, "string");
    }
  });
});
