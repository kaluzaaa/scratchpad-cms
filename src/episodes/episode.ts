import type { Event } from "@event-driven-io/emmett";

/////////////////////////////////////////
////////// Events
/////////////////////////////////////////

export type EpisodeEventMetadata = {
  user: string;
  reason?: string;
  now: string; // ISO 8601 timestamp
};

// Shared field groups (single source of truth for events, commands, and state)

export type EpisodeCreationFields = {
  episode_number: number;
  title: string;
  episode_date: string;
};

export type EpisodeContentFields = Partial<{
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
}>;

export type EpisodeDistributionFields = Partial<{
  spotify_id: string;
  apple_url: string;
  youtube_id: string;
  spreaker_id: string;
  audio_url: string;
  teaser_video_url: string;
  discord_send: boolean;
}>;

export type EpisodeCreated = Event<
  "EpisodeCreated",
  EpisodeCreationFields,
  EpisodeEventMetadata
>;

export type EpisodeContentUpdated = Event<
  "EpisodeContentUpdated",
  EpisodeContentFields,
  EpisodeEventMetadata
>;

export type TranscriptReviewed = Event<
  "TranscriptReviewed",
  Record<string, never>,
  EpisodeEventMetadata
>;

export type EpisodePublished = Event<
  "EpisodePublished",
  { published_at: string },
  EpisodeEventMetadata
>;

export type EpisodeDistributionUpdated = Event<
  "EpisodeDistributionUpdated",
  EpisodeDistributionFields,
  EpisodeEventMetadata
>;

export type EpisodeEvent =
  | EpisodeCreated
  | EpisodeContentUpdated
  | TranscriptReviewed
  | EpisodePublished
  | EpisodeDistributionUpdated;

/////////////////////////////////////////
////////// State
/////////////////////////////////////////

export type Episode =
  | { status: "NotCreated" }
  | ({
      status: "Created";
      is_published: boolean;
      transcript_reviewed: boolean;
      last_published_at?: string;
    } & EpisodeCreationFields &
      Omit<EpisodeContentFields, keyof EpisodeCreationFields> &
      EpisodeDistributionFields);

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
        ...data,
        is_published: false,
        transcript_reviewed: false,
      };
    case "EpisodeContentUpdated":
    case "EpisodeDistributionUpdated": {
      if (state.status !== "Created") return state;

      // Event data carries only the changed keys, so a shallow merge suffices.
      return { ...state, ...data };
    }
    case "TranscriptReviewed": {
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
