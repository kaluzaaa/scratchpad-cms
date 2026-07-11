import type { ReadEvent } from "@event-driven-io/emmett";
import { defaultTag, messagesTable } from "@event-driven-io/emmett-sqlite";
import type { EpisodeEvent } from "./episode";
import {
  type EpisodeDocument,
  emptyDocument,
  evolveDocument,
} from "./readModel";

// History is a read-side concern: it replays the read-model document (full
// data), not the slim aggregate, so the per-field audit diff sees everything.
type EpisodeFieldKey = Exclude<keyof EpisodeDocument, "_id" | "podcast_id">;

// All auditable episode fields (document keys minus the `_id`/`podcast_id`
// identity keys); `satisfies` keeps every entry a valid document key.
const FIELDS = [
  "episode_number",
  "title",
  "intro",
  "transcript",
  "episode_date",
  "link_notes",
  "newsletter",
  "summarization",
  "yt_chapters",
  "meta_seo",
  "duration_ms",
  "spotify_id",
  "apple_url",
  "youtube_id",
  "spreaker_id",
  "audio_url",
  "teaser_video_url",
  "discord_send",
  "is_published",
  "transcript_reviewed",
  "last_published_at",
] as const satisfies readonly EpisodeFieldKey[];

export type FieldChange = {
  field: EpisodeFieldKey;
  before: unknown;
  after: unknown;
};

export type HistoryEntry = {
  stream_position: string;
  type: EpisodeEvent["type"];
  user: string;
  reason: string | null;
  timestamp: string | null;
  changes: FieldChange[];
};

// The store stamps recorded time itself (`created` column of its messages
// table), but emmett's readStream does not expose it on read events, so
// history queries the column directly, keyed by stream position.
export const readRecordedTimestamps = async (
  db: D1Database,
  streamId: string,
): Promise<Map<string, string>> => {
  const { results } = await db
    .prepare(
      `SELECT CAST(stream_position AS TEXT) AS stream_position, created
       FROM ${messagesTable.name}
       WHERE stream_id = ?1 AND partition = ?2 AND is_archived = FALSE`,
    )
    .bind(streamId, defaultTag)
    .all<{ stream_position: string; created: string }>();

  // SQLite CURRENT_TIMESTAMP stores UTC 'YYYY-MM-DD HH:MM:SS' -> ISO 8601.
  return new Map(
    results.map(({ stream_position, created }) => [
      stream_position,
      `${created.replace(" ", "T")}Z`,
    ]),
  );
};

// Documents have no status discriminator: before the first event there is no
// document yet, so every field reads as undefined (diffs behave as before).
const fieldValue = (
  doc: EpisodeDocument | undefined,
  field: EpisodeFieldKey,
): unknown => doc?.[field];

// JSON.stringify equality covers the `meta_seo` blob too (KISS);
// unset fields stringify to undefined on both sides, so they compare equal.
const differs = (before: unknown, after: unknown): boolean =>
  JSON.stringify(before) !== JSON.stringify(after);

// Incremental replay: diff the state before/after each event to turn the
// business events into a per-field audit trail.
export const buildHistory = (
  events: ReadEvent<EpisodeEvent>[],
  recordedAt: Map<string, string>,
): HistoryEntry[] => {
  const entries: HistoryEntry[] = [];
  let state: EpisodeDocument | undefined;

  for (const event of events) {
    const next = evolveDocument(state ?? emptyDocument(), event);

    const changes: FieldChange[] = [];
    for (const field of FIELDS) {
      const before = fieldValue(state, field);
      const after = fieldValue(next, field);
      if (differs(before, after))
        changes.push({ field, before: before ?? null, after: after ?? null });
    }

    // streamPosition is a bigint (not JSON-serializable) -> string.
    const streamPosition = String(event.metadata.streamPosition);

    entries.push({
      stream_position: streamPosition,
      type: event.type,
      user: event.metadata.user,
      reason: event.metadata.reason ?? null,
      timestamp: recordedAt.get(streamPosition) ?? null,
      changes,
    });

    state = next;
  }

  return entries;
};
