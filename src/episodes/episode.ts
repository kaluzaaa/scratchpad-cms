import type { Event } from "@event-driven-io/emmett";

/////////////////////////////////////////
////////// Events
/////////////////////////////////////////

export type EpisodeEventMetadata = {
  user: string;
  reason?: string;
};

// Each event declares its payload inline; duplication between event, command,
// and state field lists is accepted by design (the publication invariant cuts
// across any grouping, so shared field-group types would match reuse, not the
// domain).

export type EpisodeCreated = Event<
  "EpisodeCreated",
  {
    podcast_id: string; // explicit business id, not derived from the stream id
    episode_number: number;
    title: string;
    episode_date: string;
  },
  EpisodeEventMetadata
>;

export type EpisodeContentUpdated = Event<
  "EpisodeContentUpdated",
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

// Two-stage transcript flow: a HappyScribe draft import, then a reviewed
// import (triggered by the proofreader's email) overwriting the same field.
// The reviewed flag gates transcript publication, not episode publication.
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

export type EpisodePublished = Event<
  "EpisodePublished",
  { published_at: string },
  EpisodeEventMetadata
>;

export type EpisodeDistributionUpdated = Event<
  "EpisodeDistributionUpdated",
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

export type EpisodeEvent =
  | EpisodeCreated
  | EpisodeContentUpdated
  | TranscriptDraftImported
  | ReviewedTranscriptImported
  | EpisodePublished
  | EpisodeDistributionUpdated;

/////////////////////////////////////////
////////// State
/////////////////////////////////////////

// Slim write model: only what invariants read. Full episode data lives in
// the events (history) and the Pongo document (serving).
export type Episode =
  | { status: "NotCreated" }
  | {
      status: "Created";
      episode_number: number; // read by requiredForPublication
      episode_date: string; // read by requiredForPublication
      has_intro: boolean; // presence flag replaces stored content
      has_spreaker_id: boolean; // presence flag replaces stored content
      is_published: boolean; // the phase marker (no Draft types by decision)
      transcript_reviewed: boolean;
      last_published_at?: string;
    };

export const initialState = (): Episode => ({ status: "NotCreated" });

/////////////////////////////////////////
////////// Evolve
/////////////////////////////////////////

export const evolve = (state: Episode, event: EpisodeEvent): Episode => {
  const { type, data } = event;

  switch (type) {
    case "EpisodeCreated":
      return {
        status: "Created",
        episode_number: data.episode_number,
        episode_date: data.episode_date,
        has_intro: false,
        has_spreaker_id: false,
        is_published: false,
        transcript_reviewed: false,
      };
    case "EpisodeContentUpdated": {
      if (state.status !== "Created") return state;

      // Only the invariant inputs; a present key sets OR clears the flag.
      return {
        ...state,
        episode_date: data.episode_date ?? state.episode_date,
        has_intro:
          data.intro !== undefined
            ? typeof data.intro === "string" && data.intro.length > 0
            : state.has_intro,
      };
    }
    case "EpisodeDistributionUpdated": {
      if (state.status !== "Created") return state;

      return {
        ...state,
        has_spreaker_id:
          data.spreaker_id !== undefined
            ? typeof data.spreaker_id === "string" &&
              data.spreaker_id.length > 0
            : state.has_spreaker_id,
      };
    }
    case "TranscriptDraftImported":
      // Milestone with no invariant impact; transcript lives in the read model.
      return state;
    case "ReviewedTranscriptImported": {
      if (state.status !== "Created") return state;

      return { ...state, transcript_reviewed: true };
    }
    case "EpisodePublished": {
      if (state.status !== "Created") return state;

      return {
        ...state,
        is_published: true,
        last_published_at: data.published_at,
      };
    }
    default: {
      const _notExistingEventType: never = type;
      return state;
    }
  }
};

/////////////////////////////////////////
////////// Stream id
/////////////////////////////////////////

export const episodeStreamId = (
  podcastId: string,
  episodeNumber: number,
): string => `episode-${podcastId}-${episodeNumber}`;
