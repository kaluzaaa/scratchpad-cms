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
    transcript: string;
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

export type ReviewTranscript = Command<
  "ReviewTranscript",
  Record<string, never>,
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
  | ReviewTranscript
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
    case "ReviewTranscript": {
      ensureCreated(state);

      return {
        type: "TranscriptReviewed",
        data: {},
        metadata: stampMetadata(metadata),
      };
    }
    case "PublishEpisode": {
      ensureCreated(state);

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
