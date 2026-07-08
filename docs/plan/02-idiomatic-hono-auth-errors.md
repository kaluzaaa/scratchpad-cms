# Idiomatic Hono Auth Errors — HTTPException + Unified problem+json

Plan file destination (per CLAUDE.md): `docs/plan/02-idiomatic-hono-auth-errors.md`.

## Context

Research against official Hono 4.x sources (middleware guide, factory helper, `HTTPException` JSDoc, and the actual `basic-auth`/`bearer-auth` middleware sources) confirmed our `requireAccess` middleware (`src/auth/middleware.ts`) is idiomatic in structure (own file + `createMiddleware` from `hono/factory`, options via factory function, per-middleware `Variables` generic, per-route scoping, `c.set` + `await next()` on success) but deviates on **error paths**: it does `return c.json({ error }, 401|403|404)` while Hono's idiom — stated in the `HTTPException` JSDoc ("`HTTPException` must be used when a fatal error such as authentication failure occurs") and followed by both built-in auth middlewares — is to **throw `HTTPException`** and centralize response shaping in `app.onError`.

Practical consequence today: the API speaks two error dialects — auth failures return `{ error: "..." }` plain JSON, domain errors (decider) go through `app.onError` in `src/index.ts` and return RFC 7807 `application/problem+json`. This refactor aligns the middleware with the Hono idiom and unifies ALL error responses to problem+json.

Out of scope (deliberate, YAGNI): `WWW-Authenticate` header on 401 — our `X-User` header is a demo pseudo-auth, not an HTTP auth scheme; a `WWW-Authenticate` challenge would be misleading. Noted in README instead. The Hono RPC caveat (issue #3985, typed error bodies) does not apply — we don't use Hono RPC.

## Current state (files involved)

- `src/auth/middleware.ts` — `requireAccess(level)` via `createMiddleware<AuthEnv>`; three `return c.json({ error }, status)` branches (404 unknown podcast → 401 missing/unknown user → 403 no grant/RO-on-RW), then `c.set('user'/'reason')` + `next()`. Check order and status codes are correct and MUST NOT change.
- `src/index.ts` — `app.onError` mapper: `isExpectedVersionConflictError` → 409 `ProblemDocument`, else `defaultErrorToProblemDetailsMapping` (emmett-honojs: ValidationError→400, IllegalStateError→403, NotFoundError→404, unknown→500); sets `Content-Type: application/problem+json`.
- `src/auth/middleware.spec.ts` — 10 `requireAccess` specs (test app = bare `new Hono<AuthEnv>()` + 2 echo routes, no onError) asserting status codes and `{ error: string }` bodies; 5 `canAccess` unit specs (unaffected).
- `src/episodes/api.ts`, `src/auth/permissions.ts` — untouched by this refactor.

## Design

1. **Extract shared error mapper** → new `src/errors.ts` exporting `problemDetailsOnError: ErrorHandler<...>` (Hono `onError` callback):
   - `error instanceof HTTPException` (import from `hono/http-exception`) → `ProblemDocument({ status: error.status, detail: error.message })`;
   - `isExpectedVersionConflictError(error)` → 409 (existing remap);
   - else `defaultErrorToProblemDetailsMapping(error)` (existing emmett mapping);
   - respond `c.json(problem, status)` + `Content-Type: application/problem+json` (move the exact logic from `src/index.ts`).
   `src/index.ts` shrinks to `app.onError(problemDetailsOnError)`. SRP/DRY: one error dialect, one place; the spec test app reuses the same handler so tests exercise the real response shape.
2. **Middleware error paths** in `src/auth/middleware.ts`: replace the three `return c.json(...)` with `throw new HTTPException(404|401|403, { message })` (messages unchanged in spirit: "Unknown podcast" / "Unknown or missing user" / "Access denied"). Success path, check order, `AuthVariables`, factory shape — all unchanged.
3. **Spec contract update** in `src/auth/middleware.spec.ts`: test app becomes `new Hono<AuthEnv>()` + routes + `.onError(problemDetailsOnError)`; error assertions switch from `{ error: string }` to problem+json: same status codes, body has `status` (number, = HTTP status) and `detail` (string), response `Content-Type` is `application/problem+json`. Pass-through/X-Reason specs unchanged. `canAccess` specs unchanged.
4. **README**: auth section + one error-format note (all errors are RFC 7807 problem+json, incl. auth; `WWW-Authenticate` deliberately omitted — pseudo-auth), tiny sample 401 body.

## Task checklist (each task = one commit; red-green per repo convention; coding via subagents with CLAUDE.md rules; pre-commit hook is non-blocking feedback — only the RED task may show failing tests)

- [x] **Task 1 — Save plan + extract shared error mapper (green→green refactor).** Save this plan as `docs/plan/02-idiomatic-hono-auth-errors.md`. Create `src/errors.ts` with `problemDetailsOnError` (logic MOVED from `src/index.ts`, incl. the HTTPException branch is NOT added yet — pure move, no behavior change); `src/index.ts` uses `app.onError(problemDetailsOnError)`. *Verify:* `npm test` 31/31 green, `npm run build` + `lint` green (no behavior change).
- [x] **Task 2 — RED: middleware specs demand problem+json.** Update the 5 error-path specs in `src/auth/middleware.spec.ts`: mount `.onError(problemDetailsOnError)` on the test app; assert status codes (unchanged), `Content-Type: application/problem+json`, body `{ status: <same number>, detail: string }`. Keep pass-through and `canAccess` specs untouched. *Verify:* typecheck + lint + build green; `npm test` — decider suite (16) + `canAccess` (5) + pass-through (5) green, the 5 error-path specs RED (middleware still returns plain `{ error }`). Commit with failing tests (expected red).
- [x] **Task 3 — GREEN: throw HTTPException + map it.** In `src/auth/middleware.ts` replace the three `return c.json(...)` with `throw new HTTPException(status, { message })`; in `src/errors.ts` add the `instanceof HTTPException` branch (before the emmett fallback). *Verify:* `npm test` ALL green (31), `npm run build` + `lint` green.
- [x] **Task 4 — E2E verification + README.** Dev server (`npx wrangler dev --port 8788`, port 8787 occupied in this environment): curl matrix — no header → 401 problem+json; `X-User: mallory` → 401; `X-User: bob` on podcast-a → 403; `podcast-x` → 404; happy paths unchanged (200 reads, 201/204 writes as alice); domain errors unchanged (duplicate create → 409 problem+json, empty PATCH → 400). Update `README.md` (unified error format note, sample 401 problem+json body, `WWW-Authenticate` omission rationale). Mark checklist complete. *Verify:* curl outputs + `npm test`/`build`/`lint` green on final state.

## Verification (end-to-end)

```bash
npm test && npm run build && npm run lint
CI=true WRANGLER_SEND_METRICS=false npx wrangler dev --port 8788

curl -i localhost:8788/podcasts/podcast-a/episodes                       # 401 problem+json (no header)
curl -i localhost:8788/podcasts/podcast-a/episodes -H 'X-User: mallory'  # 401 problem+json
curl -i localhost:8788/podcasts/podcast-a/episodes -H 'X-User: bob'      # 403 problem+json
curl -i localhost:8788/podcasts/podcast-x/episodes -H 'X-User: alice'    # 404 problem+json
curl -s localhost:8788/podcasts/podcast-a/episodes -H 'X-User: alice'    # 200 (unchanged)
# domain errors still problem+json:
curl -i -X PATCH localhost:8788/podcasts/podcast-a/episodes/1/content \
  -H 'X-User: alice' -H 'Content-Type: application/json' -d '{}'         # 400 problem+json
```

Expected 401 body shape: `{"status":401,"detail":"Unknown or missing user"}` with `Content-Type: application/problem+json`.

## Reference

- Hono factory: https://hono.dev/docs/helpers/factory · HTTPException: https://hono.dev/docs/api/exception
- Built-in auth failure idiom (throw + custom res): https://raw.githubusercontent.com/honojs/hono/main/src/middleware/bearer-auth/index.ts
- Existing utilities to reuse: `defaultErrorToProblemDetailsMapping` (`@event-driven-io/emmett-honojs`), `isExpectedVersionConflictError` (`@event-driven-io/emmett`), `ProblemDocument` (`http-problem-details`) — all already in `src/index.ts`.
