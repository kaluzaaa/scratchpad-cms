import {
  type SQLiteProjectionHandlerContext,
  sqliteProjection,
} from "@event-driven-io/emmett-sqlite";
import { type PongoClientOptions, pongoClient } from "@event-driven-io/pongo";
import { d1Driver } from "@event-driven-io/pongo/cloudflare";
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

const COLLECTION_NAME = "episodes";

// WORKAROUND (pongo 0.17.0-beta.40): emmett's `pongoSingleStreamProjection`
// hands the event store's connection to the Pongo client as nested
// `connectionOptions: { connection }`. The pg/sqlite3 Pongo drivers unpack
// that key, but the D1 driver does not — it builds a client around
// `database: undefined` and crashes on first use. Until fixed upstream, this
// projection mirrors the helper's single-stream behavior via public APIs,
// passing the ambient connection at the TOP level (which the D1 driver
// honors), keeping the same inline (same-append) consistency.
const pongoOnConnection = (
  connection: SQLiteProjectionHandlerContext["connection"],
) =>
  pongoClient({
    driver: d1Driver,
    // Reuses the event store's own connection; `database` is unused at
    // runtime when `connection` is provided, hence the cast.
    connection,
  } as unknown as PongoClientOptions<typeof d1Driver>);

// Inline projection over the `episodes` Pongo collection; its init migrates
// the collection schema, so the table is auto-created (no hand-written DDL).
export const episodesProjection = sqliteProjection<EpisodeEvent>({
  name: COLLECTION_NAME,
  canHandle: [
    "EpisodeCreated",
    "EpisodeContentUpdated",
    "TranscriptDraftImported",
    "ReviewedTranscriptImported",
    "EpisodePublished",
    "EpisodeDistributionUpdated",
  ],
  handle: async (events, context) => {
    const pongo = pongoOnConnection(context.connection);
    try {
      const collection = pongo
        .db()
        .collection<EpisodeDocument>(COLLECTION_NAME);
      for (const event of events) {
        await collection.handle(event.metadata.streamName, (document) =>
          evolveDocument(document ?? emptyDocument(), event),
        );
      }
    } finally {
      await pongo.close();
    }
  },
  init: async ({ context }) => {
    const pongo = pongoOnConnection(context.connection);
    try {
      await pongo.db().collection(COLLECTION_NAME).schema.migrate();
    } finally {
      await pongo.close();
    }
  },
});
