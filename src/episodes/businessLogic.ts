import type { Command } from "@event-driven-io/emmett";
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
  EpisodeCreationFields,
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

export const decide = (
  _command: EpisodeCommand,
  _state: Episode,
): EpisodeEvent | EpisodeEvent[] => {
  throw new Error("Not implemented");
};
