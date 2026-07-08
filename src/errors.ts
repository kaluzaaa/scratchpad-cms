import { isExpectedVersionConflictError } from "@event-driven-io/emmett";
import { defaultErrorToProblemDetailsMapping } from "@event-driven-io/emmett-honojs";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ProblemDocument } from "http-problem-details";

// Problem-details error mapper (plan-pre-approved plain-Hono variant of the
// emmett-honojs middleware). Emmett error codes already map 1:1 to the planned
// statuses (ValidationError->400, IllegalStateError->403, NotFoundError->404),
// except version conflicts, which the plan maps to 409 instead of emmett's 412.
// HTTPException (thrown by middleware, per the Hono idiom) keeps its own status.
export const problemDetailsOnError: ErrorHandler = (error, c) => {
  const problem =
    error instanceof HTTPException
      ? new ProblemDocument({ detail: error.message, status: error.status })
      : isExpectedVersionConflictError(error)
        ? new ProblemDocument({ detail: error.message, status: 409 })
        : defaultErrorToProblemDetailsMapping(error);

  const response = c.json(problem, problem.status as ContentfulStatusCode);
  response.headers.set("Content-Type", "application/problem+json");
  return response;
};
