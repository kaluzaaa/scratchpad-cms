import { createMiddleware } from "hono/factory";
import type { AccessLevel } from "./permissions";

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
export const requireAccess = (_level: AccessLevel) =>
  createMiddleware<AuthEnv>(async (_c, _next) => {
    throw new Error("Not implemented");
  });
