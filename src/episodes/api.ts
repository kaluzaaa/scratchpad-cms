import {
  CommandHandler,
  NotFoundError,
  STREAM_DOES_NOT_EXIST,
  ValidationError,
} from "@event-driven-io/emmett";
import { toWeakETag } from "@event-driven-io/emmett-honojs";
import { type PongoCollection, pongoClient } from "@event-driven-io/pongo";
import { d1Driver } from "@event-driven-io/pongo/cloudflare";
import type { Context, Hono } from "hono";
import { requireAccess } from "../auth/middleware";
import type { Env, Variables } from "../env";
import { decide, type EpisodeCommand } from "./businessLogic";
import {
  type EpisodeContentUpdated,
  type EpisodeDistributionUpdated,
  type EpisodeEvent,
  type EpisodeEventMetadata,
  episodeStreamId,
  evolve,
  initialState,
} from "./episode";
import { buildHistory, readRecordedTimestamps } from "./history";
import type { EpisodeDocument } from "./readModel";

type AppEnv = { Bindings: Env; Variables: Variables };
type AppContext = Context<AppEnv>;

const handle = CommandHandler({ evolve, initialState });

// Query-side Pongo client over the same D1 binding, memoized per Worker
// isolate like `getEventStore`. Importing `d1Driver` also registers the
// driver the inline projection resolves from the global registry.
// `session_based` transaction mode is REQUIRED on D1.
let episodes: PongoCollection<EpisodeDocument> | undefined;

const episodesCollection = (db: D1Database): PongoCollection<EpisodeDocument> =>
  (episodes ??= pongoClient({
    driver: d1Driver,
    database: db,
    transactionOptions: { mode: "session_based" },
  })
    .db()
    .collection<EpisodeDocument>("episodes"));

// Pongo returns `_version` as a BigInt, which JSON cannot serialize.
const toJsonDocument = ({
  _version,
  ...doc
}: EpisodeDocument & { _version: bigint }) => ({
  ...doc,
  _version: _version.toString(),
});

// Runtime whitelists for API body filtering (this is their only consumer);
// `satisfies` keeps every entry a valid key of the inline event payload.
// `transcript` is deliberately absent: read-only in the general content PATCH,
// written only via the transcript import routes (HappyScribe/RPC path).
const EPISODE_CONTENT_FIELD_KEYS = [
  "title",
  "intro",
  "episode_date",
  "link_notes",
  "newsletter",
  "summarization",
  "yt_chapters",
  "meta_seo",
  "duration_ms",
] as const satisfies readonly (keyof EpisodeContentUpdated["data"] & string)[];

const EPISODE_DISTRIBUTION_FIELD_KEYS = [
  "spotify_id",
  "apple_url",
  "youtube_id",
  "spreaker_id",
  "audio_url",
  "teaser_video_url",
  "discord_send",
] as const satisfies readonly (keyof EpisodeDistributionUpdated["data"] &
  string)[];

/////////////////////////////////////////
////////// Request parsing helpers
/////////////////////////////////////////

// Command metadata from the request context (set by the auth middleware);
// `reason` key is present only when the X-Reason header was sent.
const commandMetadata = (c: AppContext): EpisodeEventMetadata => {
  const reason = c.get("reason");
  return {
    user: c.get("user"),
    ...(reason !== undefined ? { reason } : {}),
  };
};

const readJsonObject = async (
  c: AppContext,
): Promise<Record<string, unknown>> => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new ValidationError("Request body must be a JSON object");
  return body as Record<string, unknown>;
};

const parseEpisodeNumber = (raw: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new ValidationError(
      `Episode number must be a positive integer, got: '${raw}'`,
    );
  return value;
};

// Params are guaranteed by the route patterns; `?? ""` only narrows the type
// (the auth middleware has already rejected unknown podcasts by this point).
const episodeStreamIdFromParams = (c: AppContext): string =>
  episodeStreamId(
    c.req.param("podcastId") ?? "",
    parseEpisodeNumber(c.req.param("episodeNumber") ?? ""),
  );

const parseTranscript = (body: Record<string, unknown>): string => {
  const { transcript } = body;
  if (typeof transcript !== "string" || transcript.length === 0)
    throw new ValidationError("transcript must be a non-empty string");
  return transcript;
};

const parseCreationFields = (
  body: Record<string, unknown>,
): { episode_number: number; title: string; episode_date: string } => {
  const { episode_number, title, episode_date } = body;
  if (
    typeof episode_number !== "number" ||
    !Number.isInteger(episode_number) ||
    episode_number <= 0
  )
    throw new ValidationError("episode_number must be a positive integer");
  if (typeof title !== "string" || title.length === 0)
    throw new ValidationError("title must be a non-empty string");
  if (typeof episode_date !== "string" || episode_date.length === 0)
    throw new ValidationError("episode_date must be a non-empty string");
  return { episode_number, title, episode_date };
};

// Whitelist filter: keeps only allowed keys actually present in the body, so
// event data carries "present keys = changed fields" and nothing else.
// An empty result (unknown-only/empty payload) is rejected by the decider.
const pickPresentKeys = <T>(
  body: Record<string, unknown>,
  allowedKeys: readonly (keyof T & string)[],
): T =>
  Object.fromEntries(
    allowedKeys.filter((key) => key in body).map((key) => [key, body[key]]),
  ) as T;

const executeCommand = (
  c: AppContext,
  streamId: string,
  command: EpisodeCommand,
) => handle(c.get("eventStore"), streamId, (state) => decide(command, state));

// Shared handler for the two transcript import routes (draft vs reviewed
// differ only in the command type); models the HappyScribe integration path.
const importTranscript =
  (type: "ImportTranscriptDraft" | "ImportReviewedTranscript") =>
  async (c: AppContext) => {
    const podcast_id = c.req.param("podcastId") ?? "";
    const episode_number = parseEpisodeNumber(
      c.req.param("episodeNumber") ?? "",
    );
    const transcript = parseTranscript(await readJsonObject(c));

    await executeCommand(c, episodeStreamId(podcast_id, episode_number), {
      type,
      data: { podcast_id, episode_number, transcript },
      metadata: commandMetadata(c),
    });

    return c.body(null, 204);
  };

/////////////////////////////////////////
////////// Routes
/////////////////////////////////////////

export const episodesApi = (router: Hono<AppEnv>): void => {
  router.post(
    "/podcasts/:podcastId/episodes",
    requireAccess("RW"),
    async (c) => {
      // `?? ""` only narrows the type; the auth middleware has already
      // rejected unknown podcasts by this point.
      const podcastId = c.req.param("podcastId") ?? "";
      const data = {
        ...parseCreationFields(await readJsonObject(c)),
        podcast_id: podcastId,
      };
      const streamId = episodeStreamId(podcastId, data.episode_number);

      const result = await handle(
        c.get("eventStore"),
        streamId,
        (state) =>
          decide(
            { type: "CreateEpisode", data, metadata: commandMetadata(c) },
            state,
          ),
        // Duplicate create hits an existing stream -> version conflict -> 409.
        { expectedStreamVersion: STREAM_DOES_NOT_EXIST },
      );

      c.header("ETag", toWeakETag(result.nextExpectedStreamVersion));
      return c.json({ stream_id: streamId }, 201);
    },
  );

  router.patch(
    "/podcasts/:podcastId/episodes/:episodeNumber/content",
    requireAccess("RW"),
    async (c) => {
      const streamId = episodeStreamIdFromParams(c);
      const data = pickPresentKeys<EpisodeContentUpdated["data"]>(
        await readJsonObject(c),
        EPISODE_CONTENT_FIELD_KEYS,
      );

      const result = await executeCommand(c, streamId, {
        type: "UpdateEpisodeContent",
        data,
        metadata: commandMetadata(c),
      });

      c.header("ETag", toWeakETag(result.nextExpectedStreamVersion));
      return c.body(null, 204);
    },
  );

  router.patch(
    "/podcasts/:podcastId/episodes/:episodeNumber/distribution",
    requireAccess("RW"),
    async (c) => {
      const streamId = episodeStreamIdFromParams(c);
      const data = pickPresentKeys<EpisodeDistributionUpdated["data"]>(
        await readJsonObject(c),
        EPISODE_DISTRIBUTION_FIELD_KEYS,
      );

      const result = await executeCommand(c, streamId, {
        type: "UpdateEpisodeDistribution",
        data,
        metadata: commandMetadata(c),
      });

      c.header("ETag", toWeakETag(result.nextExpectedStreamVersion));
      return c.body(null, 204);
    },
  );

  router.post(
    "/podcasts/:podcastId/episodes/:episodeNumber/transcript/draft",
    requireAccess("RW"),
    importTranscript("ImportTranscriptDraft"),
  );

  router.post(
    "/podcasts/:podcastId/episodes/:episodeNumber/transcript/reviewed",
    requireAccess("RW"),
    importTranscript("ImportReviewedTranscript"),
  );

  router.post(
    "/podcasts/:podcastId/episodes/:episodeNumber/publish",
    requireAccess("RW"),
    async (c) => {
      const streamId = episodeStreamIdFromParams(c);
      const metadata = commandMetadata(c);
      // published_at is a business fact generated server-side and passed as
      // command data (not metadata), keeping `decide` pure.
      const published_at = new Date().toISOString();

      await executeCommand(c, streamId, {
        type: "PublishEpisode",
        data: { published_at },
        metadata,
      });

      // Per plan: the publish action only logs (the event is the publish log).
      console.log(
        `publish: episode ${streamId} published_at ${published_at} by ${metadata.user} reason ${metadata.reason ?? "-"}`,
      );
      return c.body(null, 204);
    },
  );

  router.get(
    "/podcasts/:podcastId/episodes",
    requireAccess("RO"),
    async (c) => {
      // Read model maintained by the inline `episodes` Pongo projection;
      // queried via the query-side Pongo client (no event store involved).
      const documents = await episodesCollection(c.env.DB).find(
        { podcast_id: c.req.param("podcastId") ?? "" },
        { sort: { episode_number: 1 } },
      );

      return c.json({ episodes: documents.map(toJsonDocument) }, 200);
    },
  );

  router.get(
    "/podcasts/:podcastId/episodes/:episodeNumber",
    requireAccess("RO"),
    async (c) => {
      const streamId = episodeStreamIdFromParams(c);

      const document = await episodesCollection(c.env.DB).findOne({
        _id: streamId,
      });

      // NotFoundError -> 404 problem+json via the app-level onError mapper.
      if (document === null)
        throw new NotFoundError({ id: streamId, type: "Episode" });

      c.header("ETag", toWeakETag(document._version));
      return c.json(toJsonDocument(document), 200);
    },
  );

  router.get(
    "/podcasts/:podcastId/episodes/:episodeNumber/history",
    requireAccess("RO"),
    async (c) => {
      const streamId = episodeStreamIdFromParams(c);

      const { events, streamExists } = await c
        .get("eventStore")
        .readStream<EpisodeEvent>(streamId);

      if (!streamExists || events.length === 0)
        throw new NotFoundError({ id: streamId, type: "Episode" });

      const recordedAt = await readRecordedTimestamps(c.env.DB, streamId);

      return c.json({
        stream_id: streamId,
        entries: buildHistory(events, recordedAt),
      });
    },
  );
};
