# Embedo.ai Backend Guidelines for AI Agents (Claude Code, Codex, Antigravity)

## 1. Project Overview & Architecture
* **Stack**: Node.js 20+ (ESM), TypeScript (strict mode), Express, Prisma ORM, Redis (ioredis), BullMQ, Socket.IO, Pino logger, Zod.
* **Dual Entrypoints**:
  * `src/server.ts`: Stateless Express HTTP & Socket.IO server (`/ws/sessions`).
  * `src/worker.ts`: BullMQ worker consumers (`ai-pipeline`, `export`, `component-refresh`, `datasheet-ingest`).
* **Database**: PostgreSQL 16 with `pgvector` extension.
  * Vector columns (`vector(1536)`) for `components`, `datasheet_chunks`, and `knowledge_chunks`.

## 2. Core Modules Structure (`src/modules/`)
Follows `routes.ts` -> `controller.ts` -> `service.ts` -> `validation.ts` (Zod):
* `auth`: Email/password (consent-gated), JWT access/refresh rotation, OAuth (Google/GitHub).
* `sessions`: Session creation, Discuss-First multi-turn chat, Sufficiency Gate, AI generation pipeline, feedback, exports.
* `ai`: Facade (`model-provider.service.ts`) + Router (`ai-router.service.ts`) reading `model_routes` table.
  * Sol Tier = Frontier reasoning (Claude 3.5 Sonnet).
  * Luna Tier = Parsing/formatting (Claude 3.5 Haiku / GPT-4o-mini).
* `governance`: Tier 1 (Wordlist) -> Tier 2 (Moderation API) -> Tier 3 (Classifier) before any session or LLM call.
* `components`: Cache-first component specs & pgvector similarity search.
* `billing`: Stripe subscriptions & webhook idempotency (`subscriptions`, `billing_events`).
* `realtime`: Socket.IO session rooms (`session:{id}`) emitting `stage_update`, `clarification_needed`, `done`.

## 3. Critical Architectural Rules
1. **Never lose AI call or feedback data**: Every LLM call must write to `ai_calls` before returning. Every user action must write to `user_feedback`.
2. **Deterministic Diagram Projector**: AI outputs a semantic relational graph (`design_graph`). Plain code (`diagram-projector.ts`) projects it into the 3 frontend diagrams (Block Diagram, Power Tree, Protocol Map). Never ask LLMs for 2D pixel coordinates.
3. **Intent Sufficiency Gate**: Ambiguous intents (e.g. missing power source) must trigger clarifying questions via Discuss-First rather than hallucinating assumptions.
4. **Account Deletion**: Soft delete (`deleted_at = NOW()`) + PII scrub. Never cascade delete `design_sessions`, `ai_calls`, `user_feedback`, or `chat_messages`.
5. **No Direct Git Operations**: Do not run automated git commit or push commands unless explicitly requested by the user.
