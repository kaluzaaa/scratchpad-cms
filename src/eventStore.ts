import {
  getSQLiteEventStore,
  type SQLiteEventStore,
} from "@event-driven-io/emmett-sqlite";
import { d1EventStoreDriver } from "@event-driven-io/emmett-sqlite/cloudflare";

let initialized: Promise<SQLiteEventStore> | undefined;

// Lazy per-isolate singleton: the store is created and the schema migrated
// at most once per Worker isolate; concurrent requests await the same promise.
export const getEventStore = (db: D1Database): Promise<SQLiteEventStore> =>
  (initialized ??= (async () => {
    const store = getSQLiteEventStore({
      driver: d1EventStoreDriver,
      database: db,
      schema: { autoMigration: "None" },
    });
    await store.schema.migrate();
    return store;
  })());
