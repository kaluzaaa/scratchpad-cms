import type { SQLiteEventStore } from "@event-driven-io/emmett-sqlite";

export type Env = {
  DB: D1Database;
};

// Per-request variables; `user` will be added with the auth middleware task.
export type Variables = {
  eventStore: SQLiteEventStore;
};
