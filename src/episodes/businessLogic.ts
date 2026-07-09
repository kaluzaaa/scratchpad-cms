import {
  type Command,
  IllegalStateError,
  NotFoundError,
  ValidationError,
} from "@event-driven-io/emmett";
import type {
  Episode,
  EpisodeContentFields,
  EpisodeCreationFields,
  EpisodeDistributionFields,
  EpisodeEvent,
  EpisodeEventMetadata,
} from "./episode";

/////////////////////////////////////////
////////// Commands
/////////////////////////////////////////

export type CreateEpisode = Command<
  "CreateEpisode",
  EpisodeCreationFields & { podcast_id: string },
  EpisodeEventMetadata
>;

export type UpdateEpisodeContent = Command<
  "UpdateEpisodeContent",
  EpisodeContentFields,
  EpisodeEventMetadata
>;

export type ReviewTranscript = Command<
  "ReviewTranscript",
  Record<string, never>,
  EpisodeEventMetadata
>;

export type PublishEpisode = Command<
  "PublishEpisode",
  Record<string, never>,
  EpisodeEventMetadata
>;

export type UpdateEpisodeDistribution = Command<
  "UpdateEpisodeDistribution",
  EpisodeDistributionFields,
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
  now,
}: EpisodeEventMetadata): EpisodeEventMetadata =>
  reason !== undefined ? { user, reason, now } : { user, now };

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
        data: { published_at: metadata.now },
        metadata: stampMetadata(metadata),
      };
    }
    default: {
      const _notExistingCommandType: never = type;
      throw new ValidationError(`Unknown command type: ${type}`);
    }
  }
};
