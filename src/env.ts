import type { SQLiteEventStore } from "@event-driven-io/emmett-sqlite";
import type { AuthVariables } from "./auth/middleware";

export type Env = {
  DB: D1Database;
};

// Per-request variables; `user`/`reason` are set by the auth middleware.
export type Variables = AuthVariables & {
  eventStore: SQLiteEventStore;
};
