import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import {
  type AccessLevel,
  canAccess,
  isKnownPodcast,
  isKnownUser,
} from "./permissions";

// Variables the auth middleware contributes to the request context.
// Composed into the app-wide Variables type in src/env.ts.
export type AuthVariables = {
  user: string;
  reason?: string;
};

export type AuthEnv = { Variables: AuthVariables };

// Middleware factory guarding routes with a `:podcastId` param.
// Contract (enforced by middleware.spec.ts):
//   unknown podcast -> 404; missing/unknown X-User -> 401;
//   no grant or RO user on RW route -> 403;
//   success -> sets `user` (and `reason` from X-Reason, if present), calls next.
// Errors are thrown as HTTPException and rendered as RFC 7807 problem+json
// by the shared onError handler (src/errors.ts).
export const requireAccess = (level: AccessLevel) =>
  createMiddleware<AuthEnv>(async (c, next) => {
    const podcastId = c.req.param("podcastId") ?? "";
    if (!isKnownPodcast(podcastId)) {
      throw new HTTPException(404, { message: "Unknown podcast" });
    }

    const user = c.req.header("X-User");
    if (user === undefined || !isKnownUser(user)) {
      throw new HTTPException(401, { message: "Unknown or missing user" });
    }

    if (!canAccess(user, podcastId, level)) {
      throw new HTTPException(403, { message: "Access denied" });
    }

    c.set("user", user);
    const reason = c.req.header("X-Reason");
    if (reason !== undefined) {
      c.set("reason", reason);
    }
    await next();
  });
