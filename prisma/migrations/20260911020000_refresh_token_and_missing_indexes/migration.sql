-- Refresh token lookup index (auth.service.ts refresh() does findFirst({where:{tokenHash}})
-- on every /auth/refresh request; previously unindexed).
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- Supports users.service.ts deleteAccount()'s authIdentity.deleteMany({where:{userId}}).
CREATE INDEX IF NOT EXISTS "auth_identities_user_idx" ON "auth_identities"("user_id");

-- ---------------------------------------------------------------------------
-- Re-assert the pgvector ANN + supporting indexes declared in the init migration.
-- On this database, the init migration was originally recorded as applied via
-- `prisma migrate resolve --applied` (baseline bootstrap from a pre-existing
-- `db push`-created schema, see src/scripts/migrate.ts) rather than actually
-- executed, so these statements never ran. All are idempotent (IF NOT EXISTS).
--
-- Building an ivfflat index over the full datasheet_chunks corpus needs more
-- than Postgres's default 64MB maintenance_work_mem; SET LOCAL scopes the bump
-- to this migration's transaction only (no server-wide config change, no
-- elevated privileges required).
-- ---------------------------------------------------------------------------
SET LOCAL maintenance_work_mem = '128MB';

CREATE INDEX IF NOT EXISTS "components_embedding_idx"
  ON "components" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS "datasheet_chunks_embedding_idx"
  ON "datasheet_chunks" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS "knowledge_chunks_embedding_idx"
  ON "knowledge_chunks" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS "datasheet_chunks_component_idx" ON "datasheet_chunks" ("component_id");

CREATE INDEX IF NOT EXISTS "moderation_events_anon_idx" ON "moderation_events" ("anon_identifier");
