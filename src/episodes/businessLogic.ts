import {
  type Command,
  IllegalStateError,
  NotFoundError,
  ValidationError,
} from "@event-driven-io/emmett";
import type { Episode, EpisodeEvent, EpisodeEventMetadata } from "./episode";

/////////////////////////////////////////
////////// Commands
/////////////////////////////////////////

// Command payloads mirror the event payloads inline; duplication between the
// two lists is accepted by design (see episode.ts).

export type CreateEpisode = Command<
  "CreateEpisode",
  {
    podcast_id: string;
    episode_number: number;
    title: string;
    episode_date: string;
  },
  EpisodeEventMetadata
>;

export type UpdateEpisodeContent = Command<
  "UpdateEpisodeContent",
  Partial<{
    title: string;
    intro: string;
    episode_date: string;
    link_notes: string;
    newsletter: string;
    summarization: string;
    yt_chapters: string;
    meta_seo: unknown;
    duration_ms: number;
  }>,
  EpisodeEventMetadata
>;

export type ImportTranscriptDraft = Command<
  "ImportTranscriptDraft",
  { podcast_id: string; episode_number: number; transcript: string },
  EpisodeEventMetadata
>;

export type ImportReviewedTranscript = Command<
  "ImportReviewedTranscript",
  { podcast_id: string; episode_number: number; transcript: string },
  EpisodeEventMetadata
>;

export type PublishEpisode = Command<
  "PublishEpisode",
  // Server-generated business fact (command data, not metadata).
  { published_at: string },
  EpisodeEventMetadata
>;

export type UpdateEpisodeDistribution = Command<
  "UpdateEpisodeDistribution",
  Partial<{
    spotify_id: string;
    apple_url: string;
    youtube_id: string;
    spreaker_id: string;
    audio_url: string;
    teaser_video_url: string;
    discord_send: boolean;
  }>,
  EpisodeEventMetadata
>;

export type EpisodeCommand =
  | CreateEpisode
  | UpdateEpisodeContent
  | ImportTranscriptDraft
  | ImportReviewedTranscript
  | PublishEpisode
  | UpdateEpisodeDistribution;

/////////////////////////////////////////
////////// Business logic
/////////////////////////////////////////

// Stamps event metadata from the command, keeping only actually-present keys
// (no `reason: undefined` key when the command has no reason).
const stampMetadata = ({
  user,
  reason,
}: EpisodeEventMetadata): EpisodeEventMetadata =>
  reason !== undefined ? { user, reason } : { user };

const ensureCreated = (state: Episode): void => {
  if (state.status !== "Created") throw new NotFoundError();
};

const ensureNotEmpty = (data: Record<string, unknown>): void => {
  if (Object.keys(data).length === 0)
    throw new ValidationError("Update must contain at least one field");
};

// Hard publication gate; exported so a future advisory readiness check reuses
// the exact same rule and cannot drift from it.
export const requiredForPublication = (state: Episode): string[] =>
  state.status !== "Created"
    ? ["episode"]
    : [
        // number & date are structurally guaranteed by creation, listed
        // for domain fidelity; intro & spreaker_id are the effective gate
        !state.episode_number && "episode_number",
        !state.episode_date && "episode_date",
        !state.intro && "intro",
        !state.spreaker_id && "spreaker_id",
      ].filter((f): f is string => Boolean(f));

export const decide = (
  command: EpisodeCommand,
  state: Episode,
): EpisodeEvent => {
  const { type, data, metadata } = command;

  switch (type) {
    case "CreateEpisode": {
      if (state.status !== "NotCreated")
        throw new IllegalStateError("Episode already created");

      return {
        type: "EpisodeCreated",
        data,
        metadata: stampMetadata(metadata),
      };
    }
    case "UpdateEpisodeContent": {
      ensureCreated(state);
      ensureNotEmpty(data);

      return {
        type: "EpisodeContentUpdated",
        data,
        metadata: stampMetadata(metadata),
      };
    }
    case "UpdateEpisodeDistribution": {
      ensureCreated(state);
      ensureNotEmpty(data);

      return {
        type: "EpisodeDistributionUpdated",
        data,
        metadata: stampMetadata(metadata),
      };
    }
    case "ImportTranscriptDraft": {
      ensureCreated(state);

      return {
        type: "TranscriptDraftImported",
        data,
        metadata: stampMetadata(metadata),
      };
    }
    case "ImportReviewedTranscript": {
      ensureCreated(state);

      return {
        type: "ReviewedTranscriptImported",
        data,
        metadata: stampMetadata(metadata),
      };
    }
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
    default: {
      const _notExistingCommandType: never = type;
      throw new ValidationError(`Unknown command type: ${type}`);
    }
  }
};
