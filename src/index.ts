import { Hono } from "hono";
import type { Env, Variables } from "./env";
import { episodesApi } from "./episodes/api";
import { problemDetailsOnError } from "./errors";
import { getEventStore } from "./eventStore";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use(async (c, next) => {
  c.set("eventStore", await getEventStore(c.env.DB));
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));

episodesApi(app);

app.onError(problemDetailsOnError);

export default app;
