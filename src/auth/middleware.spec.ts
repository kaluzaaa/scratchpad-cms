import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { type AuthEnv, requireAccess } from "./middleware";
import { canAccess } from "./permissions";

/////////////////////////////////////////
////////// Test app
/////////////////////////////////////////

// Minimal app exercising the middleware in isolation (no D1, no dev server).
// Handlers echo the context variables so pass-through behavior is observable.
const app = new Hono<AuthEnv>()
  .get("/podcasts/:podcastId/test-ro", requireAccess("RO"), (c) =>
    c.json({ user: c.get("user"), reason: c.get("reason") ?? null }),
  )
  .post("/podcasts/:podcastId/test-rw", requireAccess("RW"), (c) =>
    c.json({ user: c.get("user"), reason: c.get("reason") ?? null }),
  );

const get = (podcastId: string, headers: Record<string, string> = {}) =>
  app.request(`/podcasts/${podcastId}/test-ro`, { headers });

const post = (podcastId: string, headers: Record<string, string> = {}) =>
  app.request(`/podcasts/${podcastId}/test-rw`, { method: "POST", headers });

/////////////////////////////////////////
////////// requireAccess middleware
/////////////////////////////////////////

describe("requireAccess", () => {
  it("returns 404 for an unknown podcast even with a valid user", async () => {
    const response = await get("podcast-x", { "X-User": "alice" });

    strictEqual(response.status, 404);
    const body = (await response.json()) as { error: unknown };
    strictEqual(typeof body.error, "string");
  });

  it("returns 401 when the X-User header is missing", async () => {
    const response = await get("podcast-a");

    strictEqual(response.status, 401);
    const body = (await response.json()) as { error: unknown };
    strictEqual(typeof body.error, "string");
  });

  it("returns 401 for an unknown user", async () => {
    const response = await get("podcast-a", { "X-User": "mallory" });

    strictEqual(response.status, 401);
  });

  it("returns 403 for a known user without a grant for the podcast", async () => {
    const response = await get("podcast-a", { "X-User": "bob" });

    strictEqual(response.status, 403);
  });

  it("returns 403 for an RO user on an RW route", async () => {
    const response = await post("podcast-b", { "X-User": "alice" });

    strictEqual(response.status, 403);
  });

  it("passes an RO user through on an RO route and sets user", async () => {
    const response = await get("podcast-b", { "X-User": "alice" });

    strictEqual(response.status, 200);
    const body = (await response.json()) as { user: unknown };
    strictEqual(body.user, "alice");
  });

  it("passes an RW user through on an RW route", async () => {
    const response = await post("podcast-a", { "X-User": "alice" });

    strictEqual(response.status, 200);
    const body = (await response.json()) as { user: unknown };
    strictEqual(body.user, "alice");
  });

  it("treats an RW grant as sufficient for an RO route", async () => {
    const response = await get("podcast-b", { "X-User": "bob" });

    strictEqual(response.status, 200);
    const body = (await response.json()) as { user: unknown };
    strictEqual(body.user, "bob");
  });

  it("propagates the X-Reason header into the context", async () => {
    const response = await get("podcast-a", {
      "X-User": "alice",
      "X-Reason": "spring cleaning",
    });

    strictEqual(response.status, 200);
    const body = (await response.json()) as { reason: unknown };
    strictEqual(body.reason, "spring cleaning");
  });

  it("leaves reason unset when the X-Reason header is absent", async () => {
    const response = await get("podcast-a", { "X-User": "alice" });

    strictEqual(response.status, 200);
    const body = (await response.json()) as { reason: unknown };
    strictEqual(body.reason, null);
  });
});

/////////////////////////////////////////
////////// canAccess
/////////////////////////////////////////

describe("canAccess", () => {
  it("grants alice RW on podcast-a", () => {
    strictEqual(canAccess("alice", "podcast-a", "RW"), true);
  });

  it("denies alice RW on podcast-b (only RO granted)", () => {
    strictEqual(canAccess("alice", "podcast-b", "RW"), false);
  });

  it("grants alice RO on podcast-b", () => {
    strictEqual(canAccess("alice", "podcast-b", "RO"), true);
  });

  it("denies bob RO on podcast-a (no grant)", () => {
    strictEqual(canAccess("bob", "podcast-a", "RO"), false);
  });

  it("grants bob RO on podcast-b (RW implies RO)", () => {
    strictEqual(canAccess("bob", "podcast-b", "RO"), true);
  });
});
