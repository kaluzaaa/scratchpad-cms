import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  type EventStore,
  getInMemoryEventStore,
} from "@event-driven-io/emmett";
import {
  ApiSpecification,
  existingStream,
  expectNewEvents,
  expectResponse,
  type HonoResponse,
} from "@event-driven-io/emmett-honojs";
import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { problemDetailsOnError } from "../errors";
import { episodesApi } from "./api";
import {
  type EpisodeContentUpdated,
  type EpisodeCreated,
  type EpisodeDistributionUpdated,
  type EpisodeEvent,
  episodeStreamId,
  type ReviewedTranscriptImported,
  type TranscriptDraftImported,
} from "./episode";

/////////////////////////////////////////
////////// Test app
/////////////////////////////////////////

// Outside-in HTTP specs for the command routes: emmett's Hono-native
// `ApiSpecification` drives real requests through the real stack (auth
// middleware, body parsing, decider, problem+json error mapping) over an
// in-memory event store. GET routes are excluded on purpose: they query the
// Pongo/D1 read model via `c.env.DB`, which does not exist here.

// The store of the current spec run, captured so tests can read streams back
// for exact payload assertions (the DSL's event matching is a subset check
// that would not catch extra keys leaking through a whitelist).
let currentStore: EventStore;

const buildTestApp = (eventStore: EventStore) => {
  currentStore = eventStore;
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use(async (c, next) => {
    // Command routes only use the generic EventStore surface, so the concrete
    // SQLiteEventStore in Variables can be substituted with the in-memory one.
    c.set("eventStore", eventStore as Variables["eventStore"]);
    await next();
  });
  episodesApi(app);
  app.onError(problemDetailsOnError);
  return app;
};

const given = ApiSpecification.for<EpisodeEvent>({
  getEventStore: () => getInMemoryEventStore(),
  // The DSL expects a blank-env Hono; our stricter app env is irrelevant to
  // how it drives requests (plain `app.fetch`), so widening is safe here.
  getApplication: (eventStore) => buildTestApp(eventStore) as unknown as Hono,
});

/////////////////////////////////////////
////////// Fixtures
/////////////////////////////////////////

// alice has RW on podcast-a; bob has no grant there (src/auth/permissions.ts).
const podcastId = "podcast-a";
const episodeNumber = 42;
const streamId = episodeStreamId(podcastId, episodeNumber);
const episodesPath = `/podcasts/${podcastId}/episodes`;
const episodePath = `${episodesPath}/${episodeNumber}`;
const asAlice = { "X-User": "alice" };
const metadata = { user: "alice" };

const creationBody = {
  episode_number: episodeNumber,
  title: "Event Sourcing 101",
  episode_date: "2026-07-01",
};

const episodeCreated: EpisodeCreated = {
  type: "EpisodeCreated",
  data: { ...creationBody, podcast_id: podcastId },
  metadata,
};

const introSet: EpisodeContentUpdated = {
  type: "EpisodeContentUpdated",
  data: { intro: "Welcome back!" },
  metadata,
};

const spreakerIdSet: EpisodeDistributionUpdated = {
  type: "EpisodeDistributionUpdated",
  data: { spreaker_id: "spr-42" },
  metadata,
};

/////////////////////////////////////////
////////// Assertion helpers
/////////////////////////////////////////

// RFC 7807 contract shared by every error response: status code, problem+json
// content type, matching body.status, and a string detail (exact when given).
const expectProblem =
  (status: number, detail?: string) => async (response: HonoResponse) => {
    await expectResponse(status, {
      headers: { "content-type": "application/problem+json" },
      body: detail === undefined ? { status } : { status, detail },
    })(response);
    const body = (await response.json()) as { detail: unknown };
    strictEqual(typeof body.detail, "string");
  };

const lastEventInStream = async (): Promise<EpisodeEvent> => {
  const { events } = await currentStore.readStream<EpisodeEvent>(streamId);
  const last = events.at(-1);
  if (last === undefined)
    throw new Error(`Expected events in stream ${streamId}`);
  return last;
};

/////////////////////////////////////////
////////// Specs
/////////////////////////////////////////

void describe("Episodes API (command routes)", () => {
  void describe("POST /podcasts/:podcastId/episodes", () => {
    void it("creates an episode: 201 with stream_id and an appended EpisodeCreated", () =>
      given()
        .when((request) =>
          request.post(episodesPath).set(asAlice).send(creationBody),
        )
        .then([
          expectResponse(201, { body: { stream_id: streamId } }),
          expectNewEvents(streamId, [episodeCreated]),
        ]));

    void it("rejects a duplicate create with 409 problem+json", () =>
      given(existingStream(streamId, [episodeCreated]))
        .when((request) =>
          request.post(episodesPath).set(asAlice).send(creationBody),
        )
        .then(expectProblem(409)));
  });

  void describe("PATCH /content", () => {
    void it("applies a partial update: 204 and an event carrying only the sent keys", async () => {
      const update = { intro: "Welcome back!", link_notes: "- links..." };
      const contentUpdated: EpisodeContentUpdated = {
        type: "EpisodeContentUpdated",
        data: update,
        metadata,
      };

      await given(existingStream(streamId, [episodeCreated]))
        .when((request) =>
          request.patch(`${episodePath}/content`).set(asAlice).send(update),
        )
        .then([
          expectResponse(204),
          expectNewEvents(streamId, [contentUpdated]),
        ]);

      // The DSL's subset matching cannot catch extra keys; assert exactness.
      deepStrictEqual((await lastEventInStream()).data, update);
    });

    void it("rejects a transcript-only body: the whitelist drops transcript, leaving an empty update (400)", () =>
      given(existingStream(streamId, [episodeCreated]))
        .when((request) =>
          request
            .patch(`${episodePath}/content`)
            .set(asAlice)
            .send({ transcript: "smuggled via content patch" }),
        )
        .then(expectProblem(400)));

    void it("rejects an empty body object with 400 problem+json", () =>
      given(existingStream(streamId, [episodeCreated]))
        .when((request) =>
          request.patch(`${episodePath}/content`).set(asAlice).send({}),
        )
        .then(expectProblem(400)));
  });

  void describe("PATCH /distribution", () => {
    void it("applies a partial update: 204 and an appended EpisodeDistributionUpdated", () =>
      given(existingStream(streamId, [episodeCreated]))
        .when((request) =>
          request
            .patch(`${episodePath}/distribution`)
            .set(asAlice)
            .send({ spreaker_id: "spr-42" }),
        )
        .then([
          expectResponse(204),
          expectNewEvents(streamId, [spreakerIdSet]),
        ]));
  });

  void describe("POST /transcript imports", () => {
    void it("imports the draft transcript: 204 and TranscriptDraftImported with full data", () => {
      const transcriptDraftImported: TranscriptDraftImported = {
        type: "TranscriptDraftImported",
        data: {
          podcast_id: podcastId,
          episode_number: episodeNumber,
          transcript: "draft transcript...",
        },
        metadata,
      };

      return given(existingStream(streamId, [episodeCreated]))
        .when((request) =>
          request
            .post(`${episodePath}/transcript/draft`)
            .set(asAlice)
            .send({ transcript: "draft transcript..." }),
        )
        .then([
          expectResponse(204),
          expectNewEvents(streamId, [transcriptDraftImported]),
        ]);
    });

    void it("imports the reviewed transcript: 204 and ReviewedTranscriptImported with full data", () => {
      const reviewedTranscriptImported: ReviewedTranscriptImported = {
        type: "ReviewedTranscriptImported",
        data: {
          podcast_id: podcastId,
          episode_number: episodeNumber,
          transcript: "reviewed transcript...",
        },
        metadata,
      };

      return given(existingStream(streamId, [episodeCreated]))
        .when((request) =>
          request
            .post(`${episodePath}/transcript/reviewed`)
            .set(asAlice)
            .send({ transcript: "reviewed transcript..." }),
        )
        .then([
          expectResponse(204),
          expectNewEvents(streamId, [reviewedTranscriptImported]),
        ]);
    });
  });

  void describe("POST /publish", () => {
    void it("rejects publishing an unready episode: 400 listing the missing fields", () =>
      given(existingStream(streamId, [episodeCreated]))
        .when((request) => request.post(`${episodePath}/publish`).set(asAlice))
        .then(
          expectProblem(
            400,
            "Cannot publish, missing required fields: intro, spreaker_id",
          ),
        ));

    void it("publishes a ready episode: 204 and EpisodePublished with a server-generated published_at", async () => {
      await given(
        existingStream(streamId, [episodeCreated, introSet, spreakerIdSet]),
      )
        .when((request) => request.post(`${episodePath}/publish`).set(asAlice))
        .then(expectResponse(204));

      const event = await lastEventInStream();
      strictEqual(event.type, "EpisodePublished");
      strictEqual(
        event.type === "EpisodePublished" && typeof event.data.published_at,
        "string",
      );
    });
  });

  void describe("auth contract on command routes", () => {
    void it("returns 401 problem+json when the X-User header is missing", () =>
      given()
        .when((request) => request.post(episodesPath).send(creationBody))
        .then(expectProblem(401, "Unknown or missing user")));

    void it("returns 403 problem+json for a known user without a grant", () =>
      given()
        .when((request) =>
          request
            .post(episodesPath)
            .set({ "X-User": "bob" })
            .send(creationBody),
        )
        .then(expectProblem(403, "Access denied")));

    void it("returns 404 problem+json for an unknown podcast", () =>
      given()
        .when((request) =>
          request
            .post("/podcasts/podcast-x/episodes")
            .set(asAlice)
            .send(creationBody),
        )
        .then(expectProblem(404, "Unknown podcast")));
  });
});
