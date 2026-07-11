import { pongoSingleStreamProjection } from "@event-driven-io/emmett-sqlite";
import type { EpisodeEvent } from "./episode";

// Full episode document maintained by the inline Pongo projection; serves
// both GET endpoints. Field names stay snake_case, consistent with events.
export type EpisodeDocument = {
  _id: string; // = stream name (set by the projection on write)
  podcast_id: string;
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

export const evolveDocument = (
  doc: EpisodeDocument,
  event: EpisodeEvent,
): EpisodeDocument => {
  const { type, data } = event;

  switch (type) {
    case "EpisodeCreated":
      return {
        ...doc,
        ...data,
        is_published: false,
        transcript_reviewed: false,
      };
    case "EpisodeContentUpdated":
    case "EpisodeDistributionUpdated":
      // Event data carries only the changed keys, so a shallow merge suffices.
      return { ...doc, ...data };
    case "TranscriptDraftImported":
    case "ReviewedTranscriptImported":
      // ONE transcript field, last-write-wins (reviewed overwrites draft).
      return {
        ...doc,
        transcript: data.transcript,
        transcript_reviewed:
          type === "ReviewedTranscriptImported"
            ? true
            : doc.transcript_reviewed,
      };
    case "EpisodePublished":
      return {
        ...doc,
        is_published: true,
        last_published_at: data.published_at,
      };
    default: {
      const _notExistingEventType: never = type;
      return doc;
    }
  }
};

// Fed to `evolveDocument` before the first event (here and in the history
// replay); EpisodeCreated fills the identity fields and Pongo stamps `_id`
// (= stream name) on write.
export const emptyDocument = (): EpisodeDocument => ({
  _id: "",
  podcast_id: "",
  episode_number: 0,
  title: "",
  episode_date: "",
  is_published: false,
  transcript_reviewed: false,
});

// Inline projection over the `episodes` Pongo collection; the collection
// table is auto-created via schema migration (no hand-written DDL).
// On D1 this helper requires pongo >= 0.17.0-beta.41 (the D1 driver now
// honors the nested `connectionOptions` the helper passes).
export const episodesProjection = pongoSingleStreamProjection<
  EpisodeDocument,
  EpisodeEvent
>({
  collectionName: "episodes",
  canHandle: [
    "EpisodeCreated",
    "EpisodeContentUpdated",
    "TranscriptDraftImported",
    "ReviewedTranscriptImported",
    "EpisodePublished",
    "EpisodeDistributionUpdated",
  ],
  evolve: evolveDocument,
  initialState: emptyDocument,
});
