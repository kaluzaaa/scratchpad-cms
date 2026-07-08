import type { Event } from "@event-driven-io/emmett";
import { OK } from "@event-driven-io/emmett-honojs";
import { Hono } from "hono";
import type { Env, Variables } from "./env";
import { getEventStore } from "./eventStore";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use(async (c, next) => {
  c.set("eventStore", await getEventStore(c.env.DB));
  await next();
});

// TEMPORARY probe (Task 2 de-risk spike, reverted in Task 8): appends a
// HealthChecked event and aggregates the stream back to prove the full
// append/aggregate cycle works on D1 inside workerd.
type HealthChecked = Event<"HealthChecked", { checked_at: string }>;

app.get("/health", async (c) => {
  const eventStore = c.get("eventStore");
  const streamId = "health-check";

  await eventStore.appendToStream<HealthChecked>(streamId, [
    { type: "HealthChecked", data: { checked_at: new Date().toISOString() } },
  ]);

  const { currentStreamVersion } = await eventStore.aggregateStream(streamId, {
    evolve: (state: { count: number }, _event: HealthChecked) => ({
      count: state.count + 1,
    }),
    initialState: () => ({ count: 0 }),
  });

  return OK({
    context: c,
    body: { ok: true, probe_stream_version: currentStreamVersion.toString() },
  });
});

export default app;
