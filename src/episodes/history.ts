import type { ReadEvent } from "@event-driven-io/emmett";
import {
  EPISODE_CONTENT_FIELD_KEYS,
  EPISODE_DISTRIBUTION_FIELD_KEYS,
  type Episode,
  type EpisodeEvent,
  evolve,
  initialState,
} from "./episode";

type CreatedEpisode = Extract<Episode, { status: "Created" }>;
type EpisodeFieldKey = Exclude<keyof CreatedEpisode, "status">;

// All auditable episode fields (state keys minus the `status` discriminator),
// derived from the existing runtime whitelists plus creation/flag fields.
const FIELDS = [
  "episode_number",
  ...EPISODE_CONTENT_FIELD_KEYS,
  ...EPISODE_DISTRIBUTION_FIELD_KEYS,
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
  timestamp: string;
  changes: FieldChange[];
};

const fieldValue = (state: Episode, field: EpisodeFieldKey): unknown =>
  state.status === "Created" ? state[field] : undefined;

// JSON.stringify equality covers the `meta_seo` blob too (KISS);
// unset fields stringify to undefined on both sides, so they compare equal.
const differs = (before: unknown, after: unknown): boolean =>
  JSON.stringify(before) !== JSON.stringify(after);

// Incremental replay: diff the state before/after each event to turn the
// business events into a per-field audit trail.
export const buildHistory = (
  events: ReadEvent<EpisodeEvent>[],
): HistoryEntry[] => {
  const entries: HistoryEntry[] = [];
  let state = initialState();

  for (const event of events) {
    const next = evolve(state, event);

    const changes: FieldChange[] = [];
    for (const field of FIELDS) {
      const before = fieldValue(state, field);
      const after = fieldValue(next, field);
      if (differs(before, after))
        changes.push({ field, before: before ?? null, after: after ?? null });
    }

    entries.push({
      // streamPosition is a bigint (not JSON-serializable) -> string.
      stream_position: String(event.metadata.streamPosition),
      type: event.type,
      user: event.metadata.user,
      reason: event.metadata.reason ?? null,
      timestamp: event.metadata.now,
      changes,
    });

    state = next;
  }

  return entries;
};
