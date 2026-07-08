import { isExpectedVersionConflictError } from "@event-driven-io/emmett";
import { defaultErrorToProblemDetailsMapping } from "@event-driven-io/emmett-honojs";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ProblemDocument } from "http-problem-details";
import type { Env, Variables } from "./env";
import { episodesApi } from "./episodes/api";
import { getEventStore } from "./eventStore";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use(async (c, next) => {
  c.set("eventStore", await getEventStore(c.env.DB));
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));

episodesApi(app);

// Problem-details error mapper (plan-pre-approved plain-Hono variant of the
// emmett-honojs middleware). Emmett error codes already map 1:1 to the planned
// statuses (ValidationError->400, IllegalStateError->403, NotFoundError->404),
// except version conflicts, which the plan maps to 409 instead of emmett's 412.
app.onError((error, c) => {
  const problem = isExpectedVersionConflictError(error)
    ? new ProblemDocument({ detail: error.message, status: 409 })
    : defaultErrorToProblemDetailsMapping(error);

  const response = c.json(problem, problem.status as ContentfulStatusCode);
  response.headers.set("Content-Type", "application/problem+json");
  return response;
});

export default app;
