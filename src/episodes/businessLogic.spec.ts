import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  DeciderSpecification,
  IllegalStateError,
  NotFoundError,
  ValidationError,
} from "@event-driven-io/emmett";
import { decide } from "./businessLogic";
import {
  type EpisodeCreated,
  type EpisodePublished,
  evolve,
  initialState,
  type TranscriptReviewed,
} from "./episode";

const given = DeciderSpecification.for({
  decide,
  evolve,
  initialState,
});

/////////////////////////////////////////
////////// Fixtures
/////////////////////////////////////////

const now = "2026-07-08T10:00:00.000Z";
const now2 = "2026-07-08T12:00:00.000Z";
const metadata = { user: "alice", reason: "test reason", now };
const metadata2 = { user: "alice", reason: "test reason", now: now2 };

const creationData = {
  episode_number: 42,
  title: "Event Sourcing 101",
  episode_date: "2026-07-01",
};

const episodeCreated: EpisodeCreated = {
  type: "EpisodeCreated",
  data: creationData,
  metadata,
};

const transcriptReviewed: TranscriptReviewed = {
  type: "TranscriptReviewed",
  data: {},
  metadata,
};

const episodePublished: EpisodePublished = {
  type: "EpisodePublished",
  data: { published_at: now },
  metadata,
};

/////////////////////////////////////////
////////// Specs
/////////////////////////////////////////

void describe("Episode decider", () => {
  void describe("CreateEpisode", () => {
    void it("creates an episode with data and metadata stamped from the command", () => {
      given([])
        .when({ type: "CreateEpisode", data: creationData, metadata })
        .then([{ type: "EpisodeCreated", data: creationData, metadata }]);
    });

    void it("rejects creating an already created episode", () => {
      given([episodeCreated])
        .when({ type: "CreateEpisode", data: creationData, metadata })
        .thenThrows(IllegalStateError);
    });
  });

  void describe("UpdateEpisodeContent", () => {
    void it("emits only the provided fields on partial update", () => {
      const update = { transcript: "hello...", duration_ms: 3600000 };

      given([episodeCreated])
        .when({ type: "UpdateEpisodeContent", data: update, metadata })
        .then((events) => {
          strictEqual(events.length, 1);
          strictEqual(events[0]?.type, "EpisodeContentUpdated");
          deepStrictEqual(events[0]?.data, update);
        });
    });

    void it("carries several fields including the meta_seo JSON blob verbatim", () => {
      const update = {
        title: "Event Sourcing 101 (remastered)",
        intro: "Welcome back!",
        meta_seo: {
          description: "Introduction to event sourcing",
          keywords: ["event sourcing", "cqrs"],
        },
      };

      given([episodeCreated])
        .when({ type: "UpdateEpisodeContent", data: update, metadata })
        .then((events) => {
          strictEqual(events.length, 1);
          strictEqual(events[0]?.type, "EpisodeContentUpdated");
          deepStrictEqual(events[0]?.data, update);
        });
    });

    void it("rejects an empty content update", () => {
      given([episodeCreated])
        .when({ type: "UpdateEpisodeContent", data: {}, metadata })
        .thenThrows(ValidationError);
    });

    void it("rejects updating content of a not created episode", () => {
      given([])
        .when({
          type: "UpdateEpisodeContent",
          data: { transcript: "hello..." },
          metadata,
        })
        .thenThrows(NotFoundError);
    });
  });

  void describe("UpdateEpisodeDistribution", () => {
    void it("emits only the provided fields on partial update", () => {
      const update = { spotify_id: "sp-123" };

      given([episodeCreated])
        .when({ type: "UpdateEpisodeDistribution", data: update, metadata })
        .then((events) => {
          strictEqual(events.length, 1);
          strictEqual(events[0]?.type, "EpisodeDistributionUpdated");
          deepStrictEqual(events[0]?.data, update);
        });
    });

    void it("rejects an empty distribution update", () => {
      given([episodeCreated])
        .when({ type: "UpdateEpisodeDistribution", data: {}, metadata })
        .thenThrows(ValidationError);
    });

    void it("rejects updating distribution of a not created episode", () => {
      given([])
        .when({
          type: "UpdateEpisodeDistribution",
          data: { spotify_id: "sp-123" },
          metadata,
        })
        .thenThrows(NotFoundError);
    });
  });

  void describe("ReviewTranscript", () => {
    void it("marks the transcript as reviewed", () => {
      given([episodeCreated])
        .when({ type: "ReviewTranscript", data: {}, metadata })
        .then([{ type: "TranscriptReviewed", data: {}, metadata }]);
    });

    void it("allows repeated review", () => {
      given([episodeCreated, transcriptReviewed])
        .when({ type: "ReviewTranscript", data: {}, metadata: metadata2 })
        .then([{ type: "TranscriptReviewed", data: {}, metadata: metadata2 }]);
    });
  });

  void describe("PublishEpisode", () => {
    void it("publishes with published_at taken from command metadata now", () => {
      given([episodeCreated])
        .when({ type: "PublishEpisode", data: {}, metadata })
        .then([
          { type: "EpisodePublished", data: { published_at: now }, metadata },
        ]);
    });

    void it("rejects publishing a not created episode", () => {
      given([])
        .when({ type: "PublishEpisode", data: {}, metadata })
        .thenThrows(NotFoundError);
    });

    void it("allows repeated publish, each appending its own published_at", () => {
      given([episodeCreated, episodePublished])
        .when({ type: "PublishEpisode", data: {}, metadata: metadata2 })
        .then([
          {
            type: "EpisodePublished",
            data: { published_at: now2 },
            metadata: metadata2,
          },
        ]);
    });
  });

  void describe("Metadata stamping", () => {
    void it("stamps user, reason and now from the command metadata", () => {
      given([])
        .when({ type: "CreateEpisode", data: creationData, metadata })
        .then((events) => {
          strictEqual(events.length, 1);
          deepStrictEqual(events[0]?.metadata, metadata);
        });
    });

    void it("produces no reason when the command has none", () => {
      const metadataWithoutReason = { user: "alice", now };

      given([])
        .when({
          type: "CreateEpisode",
          data: creationData,
          metadata: metadataWithoutReason,
        })
        .then((events) => {
          strictEqual(events.length, 1);
          strictEqual(events[0]?.metadata.user, "alice");
          strictEqual(events[0]?.metadata.now, now);
          strictEqual(events[0]?.metadata.reason, undefined);
        });
    });
  });
});
