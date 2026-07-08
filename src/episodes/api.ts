import {
  CommandHandler,
  NotFoundError,
  STREAM_DOES_NOT_EXIST,
  ValidationError,
} from "@event-driven-io/emmett";
import { toWeakETag } from "@event-driven-io/emmett-honojs";
import type { Context, Hono } from "hono";
import { requireAccess } from "../auth/middleware";
import type { Env, Variables } from "../env";
import { decide, type EpisodeCommand } from "./businessLogic";
import {
  EPISODE_CONTENT_FIELD_KEYS,
  EPISODE_DISTRIBUTION_FIELD_KEYS,
  type Episode,
  type EpisodeContentFields,
  type EpisodeCreationFields,
  type EpisodeDistributionFields,
  type EpisodeEvent,
  type EpisodeEventMetadata,
  episodeStreamId,
  evolve,
  initialState,
} from "./episode";
import { buildHistory } from "./history";

type AppEnv = { Bindings: Env; Variables: Variables };
type AppContext = Context<AppEnv>;

const handle = CommandHandler({ evolve, initialState });

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
    now: new Date().toISOString(),
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

const parseCreationFields = (
  body: Record<string, unknown>,
): EpisodeCreationFields => {
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

/////////////////////////////////////////
////////// Routes
/////////////////////////////////////////

export const episodesApi = (router: Hono<AppEnv>): void => {
  router.post(
    "/podcasts/:podcastId/episodes",
    requireAccess("RW"),
    async (c) => {
      const data = parseCreationFields(await readJsonObject(c));
      const streamId = episodeStreamId(
        c.req.param("podcastId") ?? "",
        data.episode_number,
      );

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
      const data = pickPresentKeys<EpisodeContentFields>(
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
      const data = pickPresentKeys<EpisodeDistributionFields>(
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
    "/podcasts/:podcastId/episodes/:episodeNumber/transcript/review",
    requireAccess("RW"),
    async (c) => {
      const streamId = episodeStreamIdFromParams(c);

      await executeCommand(c, streamId, {
        type: "ReviewTranscript",
        data: {},
        metadata: commandMetadata(c),
      });

      return c.body(null, 204);
    },
  );

  router.post(
    "/podcasts/:podcastId/episodes/:episodeNumber/publish",
    requireAccess("RW"),
    async (c) => {
      const streamId = episodeStreamIdFromParams(c);
      const metadata = commandMetadata(c);

      await executeCommand(c, streamId, {
        type: "PublishEpisode",
        data: {},
        metadata,
      });

      // Per plan: the publish action only logs (the event is the publish log).
      console.log(
        `publish: episode ${streamId} published_at ${metadata.now} by ${metadata.user} reason ${metadata.reason ?? "-"}`,
      );
      return c.body(null, 204);
    },
  );

  router.get(
    "/podcasts/:podcastId/episodes",
    requireAccess("RO"),
    async (c) => {
      // Read model maintained by the inline episodes_list projection;
      // queried straight from the D1 binding (no event store involved).
      const { results } = await c.env.DB.prepare(
        `SELECT stream_id, podcast_id, episode_number, title, episode_date, last_published_at
         FROM episodes_list WHERE podcast_id = ?1 ORDER BY episode_number`,
      )
        .bind(c.req.param("podcastId") ?? "")
        .all();

      return c.json({ episodes: results }, 200);
    },
  );

  router.get(
    "/podcasts/:podcastId/episodes/:episodeNumber",
    requireAccess("RO"),
    async (c) => {
      const streamId = episodeStreamIdFromParams(c);

      const { state, streamExists, currentStreamVersion } = await c
        .get("eventStore")
        .aggregateStream<Episode, EpisodeEvent>(streamId, {
          evolve,
          initialState,
        });

      // NotFoundError -> 404 problem+json via the app-level onError mapper.
      if (!streamExists || state.status !== "Created")
        throw new NotFoundError({ id: streamId, type: "Episode" });

      c.header("ETag", toWeakETag(currentStreamVersion));
      return c.json(state, 200);
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

      return c.json({ stream_id: streamId, entries: buildHistory(events) });
    },
  );
};
