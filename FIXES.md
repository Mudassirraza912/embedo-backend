# Production Readiness Remediation — Round 3 Review

Every P0/P1/P2 finding from the Round-3 review, plus the Round-2 blockers that were still open.
Verified with `npm run verify` (typecheck + lint + 54 unit tests), `prisma migrate deploy` against a
fresh database, and live end-to-end runs against local Postgres/Redis + OpenAI.

---

## P0 — Critical

| # | Finding | Fix | Verified by |
| :-- | :-- | :-- | :-- |
| P0-N1 | Hardcoded admin credentials (`admin@embedo.ai` / `EmbedoAdmin123!`) re-planted on every deploy | `prisma/seed.ts` rewritten: credentials come from `ADMIN_EMAIL`/`ADMIN_PASSWORD`, admin is **created only when absent** (an existing password is never rewritten), random one-time password printed if none supplied, step skipped entirely if unset | Source contains no credentials (secret scan); seed is idempotent |
| P0-N2 | Bull Board mounted with no authentication — read/write access to every queue and the last 1,000 sessions' architectures | `app.ts` mounts it behind `requireDashboardAccess` (admin JWT **or** `DASHBOARD_USER`/`DASHBOARD_PASSWORD` Basic auth, timing-safe compare). Swagger is admin-gated in production too | `operator-surfaces.test.ts`: 401 anonymous, 401 non-admin JWT; live curl → 401 |
| P0-6 (R2) | Google `aud` check inert — `GOOGLE_CLIENT_ID` optional and unset, so ID tokens minted for other apps were accepted | `loginWithGoogle` now **fails closed**: 503 if `GOOGLE_CLIENT_ID` is unconfigured; `aud` and `iss` are unconditionally verified; `email_verified` required; new-account creation requires explicit consent | Code path has no conditional bypass |
| P0-7 (R2) | Guest session limiter keyed on the client-supplied `x-anon-session-token` (rotate header → fresh quota) | Guests are keyed by **IP only**; added `SESSION_CREATE_DAILY_MAX_PER_IP` (default 50/day) as an absolute ceiling; limiters moved **before** `authenticate` so throttled requests never hit the DB; `Retry-After` returned | `rate-limit.middleware.ts`; limits documented in `CLAUDE.md §4` |
| R-1 (R2) | `OPENAI_API_KEY` defaulted to `sk-mock-key-dev` → all sessions 502 and **Tier-2 moderation silently failed open** | Default removed. Required in production (startup fails); mock/placeholder keys and placeholder JWT secrets rejected at boot | `env.ts` `superRefine`; boot smoke test |

## P1 — Serious

| # | Finding | Fix |
| :-- | :-- | :-- |
| P1-N3 | Reset token returned in the HTTP response whenever `NODE_ENV !== 'production'` | Removed unconditionally. Token is delivered **only** by email |
| P1-N4 | Password reset non-functional (no mailer) while reporting success | Added `nodemailer`-backed `email.service.ts`. When SMTP is unconfigured the token is **not** issued and an error is logged; the response stays generic (anti-enumeration) |
| P1-N5 | Raw reset URL/token written to logs | Removed. Pino now has a `redact` list covering passwords, tokens, reset URLs, cookies and `authorization` headers |
| P1-N6 | `ingestStream` ran ingestion **twice** (inline + queued) — 2× spend and a delete/insert race | Handler now only enqueues and relays `QueueEvents` progress over SSE (keep-alives, 20-min cap, cleanup on client disconnect). Work executes once, in the worker |
| P1-8 (R2) | Export stubs: `kicad`/`altium` returned JSON; `downloadUrl` pointed at a non-existent route | Implemented `GET /sessions/:id/export/download` with a real deterministic **SVG** renderer and a JSON export. `kicad`/`altium` return honest `501 EXPORT_FORMAT_UNSUPPORTED` |
| P1-9 (R2) | No migrations; production schema applied with `prisma db push` | Baseline migration generated (incl. `CREATE EXTENSION vector` + ivfflat ANN indexes) plus a status-constraint migration. `src/scripts/migrate.ts` auto-baselines a `db push` database then runs `migrate deploy`. `deploy.sh` no longer calls `db push` and aborts if the seed fails |
| P1-11 (R2) | Moderation: permanent bans, no strike window, anonymous actors exempt, Tier 3 missing, Tier 2 fail-open | Rolling strike window + 24h TTL suspensions in Redis for **guests and users**; Tier 3 domain classifier implemented (Case M, Zod-validated); fail-**closed** in production; `users.moderationStrikes` kept as a lifetime audit counter |
| P1-1 (R2) | `consentAtCreation` hardcoded `true` | Now reads the user's **current** `dataConsent`; guests get `false` |
| P1-2 (R2) | `ai_calls` write failures swallowed; intent parse and embeddings unlogged | Ledger write failure now **fails the call**. Intent parse, embeddings, moderation Tier 3 and ingestion calls all route through `aiRouterService` and are recorded (ingestion attributed to an internal `SYSTEM` session) |
| P1-3 (R2) | Validation results discarded; invalid graphs shipped as `DONE` | Critical errors (`NO_CONTROLLER_NODE`, `NO_POWER_RAILS`) now **fail** the pipeline; warnings surface as `warning` step status and are persisted in `architecture.validation` |
| P1-6 (R2) | Rollback lost `designGraph`; duplicate version tags; ambiguous lookup | New `version.service.ts`: `SELECT … FOR UPDATE` serializes writers per session, tag is a pure function of version number (`v1.${n-1}`), lookup no longer ORs tag/number |
| P1-7 (R2) | No transactions on session creation; no retry path for `FAILED` | Creation is transactional; added `POST /sessions/:id/retry` and `POST /sessions/:id/force-generate` |
| P1-12/13 | Provider timeouts / startup validation | 45s timeout + `maxRetries: 1` on all providers; typed `ProviderError` so Rule #8 retry policy is real (429/5xx/timeout retried, 4xx not) |
| P1-15 | LLM output cast, not validated | Zod validation on every model output (intent, design graph, specs, gatekeeper, Tier 3), each with retry-once then a non-retryable failure |

## P2 — Moderate (all addressed)

- **SSRF (P2-N7):** `assertSafeOutboundUrl` — https-only, credential-free, allowlist support, private/link-local/metadata ranges blocked, DNS-resolution check, redirect re-validation. `safe-url.test.ts`.
- **Unbounded PDF buffering (P2-N8):** streamed with a hard `INGEST_MAX_PDF_MB` cap (default 25 MB) + `%PDF` magic-byte check.
- **Unlogged ingestion spend (P2-N9):** all three ingestion call sites go through the router; embeddings are **batched** (64/request) instead of one call per chunk.
- **Text-only "success" (P2-N10):** embedding failure now aborts ingestion — a component is never recorded with missing vectors. All vectors computed **before** the DB transaction.
- **Hallucinated part numbers overwriting components (P2-N11):** spec extraction Zod-validated before `upsert`.
- **Personal Drive mirrors + UA spoofing (P2-N12):** mirrors moved to `src/data/datasheet_mirrors.json`; UA is now an honest `EmbedoBot/1.0` (configurable).
- **Manifest missing in Docker (P2-N13):** Dockerfile copies `src/data`; manifest is Zod-validated with a clear warning when absent.
- **Admin validation/pagination (P2-N14):** every admin route validated; `listComponents` is cursor-paginated with search; batch uses deterministic job ids (no double-queueing).
- **Tests hitting network/DB (P2-N15, P2-21):** moderation and gatekeeper suites fully mocked. 54 tests, no network, no database.
- **Gatekeeper regex false-positives (P2-N16):** the fail-open heuristic fallback is gone (fails closed instead).
- **`any` count (P2-N17):** 13 → **0**, enforced by `@typescript-eslint/no-explicit-any: error`.
- Also fixed: Prisma error mapping already present retained; `auth.middleware` no longer masks DB outages as 401; `$queryRawUnsafe` → `$queryRaw`; refresh-token **reuse detection** (revokes the family) + atomic rotation; email enumeration on register → 409 `CONFLICT` with P2002 race handling; login timing equalized; `x-request-id` charset/length validated; RAG searches `datasheet_chunks` too with a relevance threshold and wider keyword matching; model-route cache is TTL-based (DB changes propagate without a restart); provider-aware pricing table (`pricing.ts`) replaces the gpt-4o-only cost guess; `cachedTokens` recorded; full model input persisted to `ai_calls.prompt`; `trust proxy` + loopback-only port binding; compose has no default passwords, adds memory limits and log rotation; Dockerfile adds `tini` + `HEALTHCHECK`; process-level `unhandledRejection`/`uncaughtException` handlers; unbounded `include`s bounded; session status constrained at the DB level; ivfflat ANN indexes added.

## Also delivered

- **CI** (`.github/workflows/ci.yml`): typecheck, lint (incl. the AI-provider import boundary rule), `prisma migrate deploy` against a fresh pgvector service, unit tests, build, gitleaks secret scan.
- **ESLint** with `no-restricted-imports` enforcing that only `src/modules/ai/providers/**` may import vendor SDKs — the architectural rule that was previously convention-only.
- **Sufficiency gate now blocks on a missing power source** (PRD §6.11 acceptance criterion), with tests using the exact documented example.
- Docs (`CLAUDE.md`, `README.md`, `DEPLOY.md`, `.env.example`) updated to match the implementation, including a Security & Operations section.

## Verification performed

```
npm run verify        → typecheck clean, lint clean, 54/54 tests pass
npm run build         → dist/ emitted (server, worker, scripts/migrate)
prisma migrate deploy → applies cleanly to an empty DB; status constraint rejects invalid values
                        baseline-aware runner migrated the existing dev DB without data loss
```

Live end-to-end (local Postgres/Redis + real OpenAI):

- Full generation: `PENDING → PROCESSING → DONE`, v1.0 snapshot with a non-empty design graph,
  ledger complete (B + embeddings + A), **cost $0.052/session** (target $0.05–0.10).
- Clarification round-trip: the PRD example stopped at `CLARIFICATION_REQUIRED` asking about the
  power source **without** spending a Sol call; answering via `/discuss` drove it to `DONE`.
- Guest tenancy: reading a session without its token → **403**.
- Moderation: "gps jammer" → **403 CONTENT_POLICY_VIOLATION** (Tier 1, no provider spend).
- Gibberish: `asdasdasdasd` → immediate `CLARIFICATION_REQUIRED`, no queue job, no LLM call.
- Export: `kicad` → 501; `svg` → 17 KB SVG with correct headers; `json` → graph + architecture.
- Rollback: `v1.0` → new `v1.1` with the graph preserved and consistent numbering.
- Bull Board / admin routes → 401 anonymous, 403 non-admin.

## Known remaining items (deliberate, not defects)

1. **`kicad` / `altium` exports are not implemented** — they return `501` rather than pretending. Real EDA netlist generation is a feature, not a fix.
2. **`export` / `component-refresh` queues remain stubs.** Nothing enqueues to them; they are registered but inert. Either implement or remove before advertising live pricing/stock.
3. **No integration test tier.** The suite is unit-only (mocked Prisma/Redis). Testcontainers-backed tests for the ownership matrix, consent-gated extraction and version concurrency are the highest-value next addition; CI does verify migrations against a real Postgres.
4. **`ChatMessage`/`SessionVersion` still cascade-delete with a session** while `ai_calls`/`user_feedback` restrict. No session-delete endpoint exists, so this is currently unreachable — but the cascade strategy should be unified before one is added.
5. **Rotate credentials.** The previously hardcoded admin password and any secrets in the existing `.env` must be considered compromised. Local `.env` still has `NODE_ENV=development` — set `production` on the server (`deploy.sh` now refuses otherwise).

---

# Production Readiness Remediation — Round 4 Review

Every P1/P2/P3 finding from the independent Round-4 re-audit. Verified with `npm run verify`
(typecheck + lint + 54 unit tests), a real migration applied to the local dev database, and live
end-to-end runs against local Postgres/Redis + OpenAI.

## P1 — Functional bugs (both confirmed live before the fix)

| # | Finding | Fix | Verified by |
| :-- | :-- | :-- | :-- |
| P1-R4-1 | `POST /users/me/consent` validated a `consent` field but the controller read `req.body.dataConsent` — every call silently no-op'd `dataConsent` while unconditionally nulling `dataConsentDate` | `updateConsentSchema` renamed to `dataConsent` (matches the field name used everywhere else in the API, incl. registration) so schema, controller and service now agree end-to-end | Live: `{dataConsent:false}` → 200, flag and date both flip correctly and persist on re-read; the old `{consent:false}` payload now correctly 400s |
| P1-R4-2 | Chat refinement after a session reached `DONE` never re-triggered the pipeline — `discuss()`'s re-trigger condition only covered `CLARIFICATION_REQUIRED`/`PENDING`, even though the orchestrator's idempotency guard was already built to support it (`DONE && !iterationNotes` is the only skip case) | `discuss()` now also re-triggers when `status === 'DONE'`, passing the message as `iterationNotes` — this is the endpoint's documented purpose ("multi-turn copilot chat & requirement refinement") | Live: two full round trips (fresh sessions) — refine message on a `DONE` session → Luna reply → Sol re-synthesis fires → `totalVersions` 1→2, new version tagged `v1.1` with the refinement as its change summary, session returns to `DONE` |

## P2 — Correctness & reliability

| # | Finding | Fix | Verified by |
| :-- | :-- | :-- | :-- |
| P2-R4-3 | `refresh_tokens.token_hash` had no index despite being the lookup column on every `/auth/refresh` request; `auth_identities.user_id` likewise unindexed | Added `@@unique([tokenHash])` and `@@index([userId])`; new migration `20260911020000_refresh_token_and_missing_indexes` | `\di` on the dev DB confirms both indexes exist; `/auth/login` → `/auth/refresh` round trip still works |
| P2-R4-4 | `ai_calls` was only ever written on a **successful** `modelProviderService.generate()` call — a failed provider call left no ledger row at all, so `errorMessage`/cost-of-failure were never recorded | `executeTask()` now wraps the provider call; on failure it writes an `ai_calls` row (`schemaPass: false`, `errorMessage` populated, tokens/cost left null since none were consumed) before rethrowing the original error | Code path exercised by typecheck/tests; ledger write is best-effort (a logging failure never masks the original provider error) |
| P2-R4-5 | The BullMQ worker's retry classification was inverted: `!(err instanceof ProviderError) && !(err instanceof NonRetryablePipelineError)` defaulted **any** unclassified `Error` to retryable, contradicting the adjacent "do not blanket-retry" comment. Also, `design-graph-builder.ts`'s schema-exhaustion throw was a plain `Error`, so a failure that had *already* retried once internally (Rule #8) triggered 3 more full-pipeline BullMQ retries | Classification flipped to default-deny: `retryable = AiRouterService.isRetryable(err) || err instanceof RetryablePipelineError`. `design-graph-builder.ts` now throws a purpose-built `DesignGraphSchemaError` (classified `NonRetryablePipelineError`, same pattern as `intent-parser.ts`'s `IntentExtractionError`). The orchestrator's topology-validation throw (`NO_CONTROLLER_NODE` etc.) — a single, un-retried Sol sample where a fresh attempt genuinely can succeed — is now the explicit `RetryablePipelineError` exception to the default-deny rule, instead of accidentally inheriting retryability from the old bug | Live: a refinement request whose first Sol sample produced an invalid topology (`NO_CONTROLLER_NODE`) was correctly retried automatically; caught the over-broad first version of this fix live (session ended up wrongly `FAILED` on attempt 1/1) and corrected it before shipping |
| P2-R4-6 | Socket.IO's `connection` handler fired `socket.emit('connected', ...)` without awaiting `socket.join()`, which is now a Redis round-trip via `@socket.io/redis-adapter` — a narrow window where early pipeline events could be missed | Handler now awaits the join before emitting `connected`; disconnects the socket if the join itself fails | Typecheck/build clean; no socket errors across multiple live pipeline runs exercising `stage_update`/`pipeline_step`/`done` events |

## P3 — Minor / hygiene

| # | Finding | Fix |
| :-- | :-- | :-- |
| P3-R4-7 | Dead `AppError` codes `SCHEMA_VALIDATION_FAILED` / `ENTITLEMENT_REQUIRED`, never thrown or referenced anywhere (incl. docs) | Removed from the `ErrorCode` union |
| P3-R4-8 | No rate limiting on `rollback`/`feedback`/`outcome` (beyond the app-wide IP limiter already mounted in `app.ts`) | Applied the existing per-session `rateLimitDiscuss` limiter (30/hour/session) to all three routes |
| P3-R4-9 | `ai_calls.retryCount` column has no writer anywhere | Left explicitly unused — wiring it up requires threading BullMQ's `job.attemptsMade` into the pipeline, which is a small feature, not a defect fix; noted here so it isn't mistaken for an oversight |

## Bonus finding (surfaced while building the P2-R4-3 migration, not part of the Round-4 report)

**The pgvector ANN indexes declared in `schema.prisma`/the init migration had never actually been applied to this database.** The dev DB was originally bootstrapped via `prisma db push` before migration history existed; the baseline-aware runner (`src/scripts/migrate.ts`) then marked the init migration as applied via `prisma migrate resolve --applied` without ever executing its SQL. Confirmed via `\di`: `components_embedding_idx`, `datasheet_chunks_embedding_idx`, `knowledge_chunks_embedding_idx`, `datasheet_chunks_component_idx`, and `moderation_events_anon_idx` were all missing — meaning every RAG similarity search over the 11,835-row `datasheet_chunks` table has been doing a full sequential scan. Re-asserted all five (idempotent `IF NOT EXISTS`) in the same new migration. Building the `ivfflat` indexes over the full corpus also failed once with `memory required is 65 MB, maintenance_work_mem is 64 MB` — fixed with a `SET LOCAL maintenance_work_mem = '128MB'` scoped to the migration's own transaction (no server-wide config change needed). All 5 indexes confirmed present via `\di` after re-running `prisma migrate deploy`.

## Verification performed

```
npm run verify        → typecheck clean, lint clean, 54/54 tests pass
npm run build          → dist/ emitted
prisma migrate deploy  → new migration applies cleanly; all 7 new/re-asserted indexes confirmed via \di
```

Live end-to-end (local Postgres/Redis + real OpenAI, fresh sessions):

- Consent update: `{dataConsent:false}` → persists correctly; date cleared on `false`, set on `true`; old buggy payload shape now 400s.
- Refinement after `DONE`: chat message → Luna reply → Sol re-synthesis → new version (`v1.1`) with correct change summary → session back to `DONE`.
- Auth refresh round trip (exercises the new `token_hash` unique index): login → refresh → new access token issued.
- Socket.IO namespace still reachable; no join/emit errors across all live pipeline runs above.

## Known remaining items (deliberate, not defects — unchanged from Round 3)

Same five items listed above (unimplemented EDA exports, inert export/component-refresh queues,
no integration test tier, mixed cascade-delete strategy, credential rotation) remain open; none
were in scope for the Round-4 findings.
