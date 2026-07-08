export type Env = {
  DB: D1Database;
};

// Per-request variables (event store, user) will be added in later tasks.
export type Variables = Record<string, never>;
