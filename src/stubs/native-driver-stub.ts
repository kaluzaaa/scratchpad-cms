// Bundling stub for the optional native drivers `pg` and `sqlite3`.
// The emmett-sqlite root barrel transitively imports them (via pongo/dumbo),
// but with the D1 driver those code paths are never executed at runtime.
// Wrangler's `alias` config points both module names here so the Worker bundles.
export default {};
