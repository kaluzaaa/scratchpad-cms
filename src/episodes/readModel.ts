import { SQL } from "@event-driven-io/dumbo";
import type { ReadEvent } from "@event-driven-io/emmett";
import {
  type SQLiteReadEventMetadata,
  sqliteRawSQLProjection,
} from "@event-driven-io/emmett-sqlite";
import {
  type EpisodeContentUpdated,
  type EpisodeCreated,
  type EpisodePublished,
  parseEpisodeStreamId,
} from "./episode";

// Runs on every schema.migrate() (idempotent), so the read-model table is
// created together with the event store schema — no separate bootstrap.
const initSQL = SQL`
  CREATE TABLE IF NOT EXISTS episodes_list (
    stream_id TEXT PRIMARY KEY,
    podcast_id TEXT NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    episode_date TEXT NOT NULL,
    last_published_at TEXT
  );
`;

// Read events carry recorded metadata (incl. streamName) set on append.
type EpisodesListEvent = ReadEvent<
  EpisodeCreated | EpisodeContentUpdated | EpisodePublished,
  SQLiteReadEventMetadata
>;

const evolve = (event: EpisodesListEvent): SQL => {
  const streamId = event.metadata.streamName;

  switch (event.type) {
    case "EpisodeCreated": {
      const { podcastId } = parseEpisodeStreamId(streamId);
      const { episode_number, title, episode_date } = event.data;

      return SQL`
        INSERT INTO episodes_list
          (stream_id, podcast_id, episode_number, title, episode_date)
        VALUES
          (${streamId}, ${podcastId}, ${episode_number}, ${title}, ${episode_date})
        ON CONFLICT (stream_id) DO UPDATE SET
          episode_number = excluded.episode_number,
          title = excluded.title,
          episode_date = excluded.episode_date;`;
    }
    case "EpisodeContentUpdated": {
      // Event data carries only the changed keys; COALESCE keeps the current
      // value when a key is absent (title/episode_date are never null here).
      const { title, episode_date } = event.data;

      return SQL`
        UPDATE episodes_list SET
          title = COALESCE(${title ?? null}, title),
          episode_date = COALESCE(${episode_date ?? null}, episode_date)
        WHERE stream_id = ${streamId};`;
    }
    case "EpisodePublished":
      return SQL`
        UPDATE episodes_list SET last_published_at = ${event.data.published_at}
        WHERE stream_id = ${streamId};`;
  }
};

export const episodesListProjection = sqliteRawSQLProjection<EpisodesListEvent>(
  {
    name: "episodesList",
    canHandle: ["EpisodeCreated", "EpisodeContentUpdated", "EpisodePublished"],
    init: () => initSQL,
    evolve,
  },
);
