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
  type EpisodeContentUpdated,
  type EpisodeCreated,
  type EpisodeDistributionUpdated,
  type EpisodePublished,
  evolve,
  initialState,
  type TranscriptDraftImported,
} from "./episode";

const given = DeciderSpecification.for({
  decide,
  evolve,
  initialState,
});

/////////////////////////////////////////
////////// Fixtures
/////////////////////////////////////////

const published_at = "2026-07-08T10:00:00.000Z";
const published_at2 = "2026-07-08T12:00:00.000Z";
const metadata = { user: "alice", reason: "test reason" };

const creationData = {
  podcast_id: "patoarchitekci",
  episode_number: 42,
  title: "Event Sourcing 101",
  episode_date: "2026-07-01",
};

const episodeCreated: EpisodeCreated = {
  type: "EpisodeCreated",
  data: creationData,
  metadata,
};

const draftImportData = {
  podcast_id: "patoarchitekci",
  episode_number: 42,
  transcript: "draft transcript...",
};

const reviewedImportData = {
  ...draftImportData,
  transcript: "reviewed transcript...",
};

const transcriptDraftImported: TranscriptDraftImported = {
  type: "TranscriptDraftImported",
  data: draftImportData,
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

const episodePublished: EpisodePublished = {
  type: "EpisodePublished",
  data: { published_at },
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
      const update = { link_notes: "- links...", duration_ms: 3600000 };

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
          data: { intro: "hello..." },
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

  void describe("ImportTranscriptDraft", () => {
    void it("imports the draft transcript with full data", () => {
      given([episodeCreated])
        .when({
          type: "ImportTranscriptDraft",
          data: draftImportData,
          metadata,
        })
        .then([
          { type: "TranscriptDraftImported", data: draftImportData, metadata },
        ]);
    });

    void it("does not mark the transcript as reviewed", () => {
      const state = [episodeCreated, transcriptDraftImported].reduce(
        evolve,
        initialState(),
      );

      strictEqual(state.status, "Created");
      strictEqual(
        state.status === "Created" && state.transcript_reviewed,
        false,
      );
    });

    void it("rejects importing into a not created episode", () => {
      given([])
        .when({
          type: "ImportTranscriptDraft",
          data: draftImportData,
          metadata,
        })
        .thenThrows(NotFoundError);
    });
  });

  void describe("ImportReviewedTranscript", () => {
    void it("imports the reviewed transcript, overwriting the draft", () => {
      given([episodeCreated, transcriptDraftImported])
        .when({
          type: "ImportReviewedTranscript",
          data: reviewedImportData,
          metadata,
        })
        .then([
          {
            type: "ReviewedTranscriptImported",
            data: reviewedImportData,
            metadata,
          },
        ]);
    });

    void it("marks the transcript as reviewed", () => {
      const state = [
        episodeCreated,
        transcriptDraftImported,
        {
          type: "ReviewedTranscriptImported",
          data: reviewedImportData,
          metadata,
        } as const,
      ].reduce(evolve, initialState());

      strictEqual(
        state.status === "Created" && state.transcript_reviewed,
        true,
      );
    });

    void it("rejects importing into a not created episode", () => {
      given([])
        .when({
          type: "ImportReviewedTranscript",
          data: reviewedImportData,
          metadata,
        })
        .thenThrows(NotFoundError);
    });
  });

  void describe("PublishEpisode", () => {
    void it("publishes once intro and spreaker_id were set, with published_at taken from the command data", () => {
      given([episodeCreated, introSet, spreakerIdSet])
        .when({ type: "PublishEpisode", data: { published_at }, metadata })
        .then([{ type: "EpisodePublished", data: { published_at }, metadata }]);
    });

    void it("rejects publishing a not created episode", () => {
      given([])
        .when({ type: "PublishEpisode", data: { published_at }, metadata })
        .thenThrows(NotFoundError);
    });

    void it("rejects publishing when intro is missing", () => {
      given([episodeCreated, spreakerIdSet])
        .when({ type: "PublishEpisode", data: { published_at }, metadata })
        .thenThrows(
          (error: Error) =>
            error instanceof ValidationError &&
            error.message === "Cannot publish, missing required fields: intro",
        );
    });

    void it("rejects publishing when spreaker_id is missing", () => {
      given([episodeCreated, introSet])
        .when({ type: "PublishEpisode", data: { published_at }, metadata })
        .thenThrows(
          (error: Error) =>
            error instanceof ValidationError &&
            error.message ===
              "Cannot publish, missing required fields: spreaker_id",
        );
    });

    void it("rejects publishing listing both missing fields when neither is set", () => {
      given([episodeCreated])
        .when({ type: "PublishEpisode", data: { published_at }, metadata })
        .thenThrows(
          (error: Error) =>
            error instanceof ValidationError &&
            error.message ===
              "Cannot publish, missing required fields: intro, spreaker_id",
        );
    });

    void it("allows repeated publish, each appending its own published_at", () => {
      given([episodeCreated, introSet, spreakerIdSet, episodePublished])
        .when({
          type: "PublishEpisode",
          data: { published_at: published_at2 },
          metadata,
        })
        .then([
          {
            type: "EpisodePublished",
            data: { published_at: published_at2 },
            metadata,
          },
        ]);
    });
  });

  void describe("Metadata stamping", () => {
    void it("stamps user and reason from the command metadata", () => {
      given([])
        .when({ type: "CreateEpisode", data: creationData, metadata })
        .then((events) => {
          strictEqual(events.length, 1);
          deepStrictEqual(events[0]?.metadata, metadata);
        });
    });

    void it("produces no reason when the command has none", () => {
      const metadataWithoutReason = { user: "alice" };

      given([])
        .when({
          type: "CreateEpisode",
          data: creationData,
          metadata: metadataWithoutReason,
        })
        .then((events) => {
          strictEqual(events.length, 1);
          deepStrictEqual(events[0]?.metadata, metadataWithoutReason);
        });
    });
  });
});
