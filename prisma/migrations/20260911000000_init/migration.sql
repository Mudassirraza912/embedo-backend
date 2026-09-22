-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "hashed_password" VARCHAR(255),
    "role" VARCHAR(20) NOT NULL DEFAULT 'user',
    "expertise_level" VARCHAR(50),
    "data_consent" BOOLEAN NOT NULL DEFAULT false,
    "data_consent_date" TIMESTAMP(6),
    "moderation_strikes" INTEGER NOT NULL DEFAULT 0,
    "suspended_at" TIMESTAMP(6),
    "deleted_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "provider_user_id" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "revoked_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replaced_by_id" UUID,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "design_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "anon_session_token" VARCHAR(255),
    "intent_text" TEXT NOT NULL,
    "intent_structured" JSONB,
    "design_graph" JSONB,
    "domain" VARCHAR(100),
    "application_context" VARCHAR(100),
    "architecture" JSONB,
    "parent_session_id" UUID,
    "status" VARCHAR(50) NOT NULL DEFAULT 'active',
    "consent_at_creation" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "version_tag" VARCHAR(20) NOT NULL,
    "change_summary" TEXT NOT NULL,
    "applied_changes" TEXT[],
    "design_graph" JSONB NOT NULL,
    "architecture" JSONB NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "user_id" UUID,
    "role" VARCHAR(20) NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "task_case" CHAR(1) NOT NULL,
    "model_provider" VARCHAR(50) NOT NULL,
    "model_name" VARCHAR(100) NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cached_tokens" INTEGER,
    "cost_usd" DECIMAL(10,6),
    "latency_ms" INTEGER,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "schema_pass" BOOLEAN,
    "error_message" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "ai_call_id" UUID,
    "action" VARCHAR(50) NOT NULL,
    "modifications" JSONB,
    "rating" INTEGER,
    "notes" TEXT,
    "time_to_action_seconds" INTEGER,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "design_outcomes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "exported" BOOLEAN NOT NULL DEFAULT false,
    "export_format" VARCHAR(50),
    "export_file_key" VARCHAR(500),
    "fabricated" BOOLEAN,
    "worked_first_time" BOOLEAN,
    "iterations_to_working" INTEGER,
    "feedback_notes" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "components" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "part_number" VARCHAR(255),
    "manufacturer" VARCHAR(255),
    "category" VARCHAR(100),
    "specs" JSONB,
    "datasheet_url" TEXT,
    "source" VARCHAR(50),
    "last_refreshed" TIMESTAMP(6),
    "embedding" vector(1536),

    CONSTRAINT "components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "datasheet_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "component_id" UUID,
    "chunk_text" TEXT,
    "chunk_metadata" JSONB,
    "page_number" INTEGER,
    "embedding" vector(1536),

    CONSTRAINT "datasheet_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_type" VARCHAR(50) NOT NULL,
    "source_url" TEXT,
    "title" VARCHAR(500),
    "chunk_text" TEXT NOT NULL,
    "chunk_metadata" JSONB,
    "embedding" vector(1536),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_routes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_case" CHAR(1) NOT NULL,
    "domain" VARCHAR(100),
    "model_provider" VARCHAR(50) NOT NULL,
    "model_name" VARCHAR(100) NOT NULL,
    "temperature" DECIMAL(3,2) NOT NULL DEFAULT 0.20,
    "max_tokens" INTEGER NOT NULL DEFAULT 4096,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "stripe_customer_id" VARCHAR(255) NOT NULL,
    "stripe_subscription_id" VARCHAR(255),
    "plan" VARCHAR(50) NOT NULL,
    "status" VARCHAR(50) NOT NULL,
    "current_period_end" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "stripe_event_id" VARCHAR(255) NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(100),
    "entity_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "anon_identifier" VARCHAR(255),
    "session_id" UUID,
    "tier" VARCHAR(20) NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "flagged_text" TEXT NOT NULL,
    "action_taken" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_provider_user_id_key" ON "auth_identities"("provider", "provider_user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "design_sessions_user_idx" ON "design_sessions"("user_id");

-- CreateIndex
CREATE INDEX "design_sessions_anon_idx" ON "design_sessions"("anon_session_token");

-- CreateIndex
CREATE INDEX "design_sessions_status_idx" ON "design_sessions"("status");

-- CreateIndex
CREATE INDEX "session_versions_session_idx" ON "session_versions"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_versions_session_version_unique" ON "session_versions"("session_id", "version_number");

-- CreateIndex
CREATE INDEX "chat_messages_session_idx" ON "chat_messages"("session_id");

-- CreateIndex
CREATE INDEX "chat_messages_user_idx" ON "chat_messages"("user_id");

-- CreateIndex
CREATE INDEX "ai_calls_session_idx" ON "ai_calls"("session_id");

-- CreateIndex
CREATE INDEX "ai_calls_created_idx" ON "ai_calls"("created_at");

-- CreateIndex
CREATE INDEX "user_feedback_session_idx" ON "user_feedback"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "design_outcomes_session_id_key" ON "design_outcomes"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "components_part_number_key" ON "components"("part_number");

-- CreateIndex
CREATE INDEX "components_part_number_idx" ON "components"("part_number");

-- CreateIndex
CREATE INDEX "knowledge_chunks_source_type_idx" ON "knowledge_chunks"("source_type");

-- CreateIndex
CREATE UNIQUE INDEX "model_routes_task_case_domain_key" ON "model_routes"("task_case", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "subscriptions_user_idx" ON "subscriptions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_stripe_event_id_key" ON "billing_events"("stripe_event_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_idx" ON "audit_log"("actor_user_id");

-- CreateIndex
CREATE INDEX "moderation_events_user_idx" ON "moderation_events"("user_id");

-- CreateIndex
CREATE INDEX "moderation_events_created_idx" ON "moderation_events"("created_at");

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_parent_session_id_fkey" FOREIGN KEY ("parent_session_id") REFERENCES "design_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_versions" ADD CONSTRAINT "session_versions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "design_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "design_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "design_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "design_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_ai_call_id_fkey" FOREIGN KEY ("ai_call_id") REFERENCES "ai_calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_outcomes" ADD CONSTRAINT "design_outcomes_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "design_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "datasheet_chunks" ADD CONSTRAINT "datasheet_chunks_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_events" ADD CONSTRAINT "moderation_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_events" ADD CONSTRAINT "moderation_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "design_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- pgvector approximate-nearest-neighbour indexes (cosine). Not expressible in
-- schema.prisma, so they live here. ivfflat lists are sized for the projected
-- Year-1/2 corpus; revisit (or switch to hnsw) once tables exceed ~1M rows.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "components_embedding_idx"
  ON "components" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS "datasheet_chunks_embedding_idx"
  ON "datasheet_chunks" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS "knowledge_chunks_embedding_idx"
  ON "knowledge_chunks" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

-- Supports the datasheet_chunks -> components join used by RAG grounding
CREATE INDEX IF NOT EXISTS "datasheet_chunks_component_idx" ON "datasheet_chunks" ("component_id");

-- Supports anonymous-actor moderation lookups
CREATE INDEX IF NOT EXISTS "moderation_events_anon_idx" ON "moderation_events" ("anon_identifier");
