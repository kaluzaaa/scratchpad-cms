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
  | TranscriptReviewed
  | EpisodePublished
  | EpisodeDistributionUpdated;

/////////////////////////////////////////
////////// State
/////////////////////////////////////////

export type Episode =
  | { status: "NotCreated" }
  | {
      status: "Created";
      episode_number: number;
      title: string;
      episode_date: string;
      intro?: string;
      transcript?: string;
      link_notes?: string;
      newsletter?: string;
      summarization?: string;
      yt_chapters?: string;
      meta_seo?: unknown;
      duration_ms?: number;
      spotify_id?: string;
      apple_url?: string;
      youtube_id?: string;
      spreaker_id?: string;
      audio_url?: string;
      teaser_video_url?: string;
      discord_send?: boolean;
      is_published: boolean;
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
