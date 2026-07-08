import { createMiddleware } from "hono/factory";
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
// Error responses are JSON: { error: string }.
export const requireAccess = (level: AccessLevel) =>
  createMiddleware<AuthEnv>(async (c, next) => {
    const podcastId = c.req.param("podcastId") ?? "";
    if (!isKnownPodcast(podcastId)) {
      return c.json({ error: "Unknown podcast" }, 404);
    }

    const user = c.req.header("X-User");
    if (user === undefined || !isKnownUser(user)) {
      return c.json({ error: "Unknown or missing user" }, 401);
    }

    if (!canAccess(user, podcastId, level)) {
      return c.json({ error: "Access denied" }, 403);
    }

    c.set("user", user);
    const reason = c.req.header("X-Reason");
    if (reason !== undefined) {
      c.set("reason", reason);
    }
    await next();
  });
