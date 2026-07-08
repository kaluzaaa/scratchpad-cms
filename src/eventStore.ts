import { projections } from "@event-driven-io/emmett";
import {
  getSQLiteEventStore,
  type SQLiteEventStore,
} from "@event-driven-io/emmett-sqlite";
import { d1EventStoreDriver } from "@event-driven-io/emmett-sqlite/cloudflare";
import { episodesListProjection } from "./episodes/readModel";

let initialized: Promise<SQLiteEventStore> | undefined;

// Lazy per-isolate singleton: the store is created and the schema migrated
// at most once per Worker isolate; concurrent requests await the same promise.
export const getEventStore = (db: D1Database): Promise<SQLiteEventStore> =>
  (initialized ??= (async () => {
    const store = getSQLiteEventStore({
      driver: d1EventStoreDriver,
      database: db,
      schema: { autoMigration: "None" },
      projections: projections.inline([episodesListProjection]),
    });
    // Also runs inline projections' init SQL (episodes_list table creation).
    await store.schema.migrate();
    return store;
  })());
