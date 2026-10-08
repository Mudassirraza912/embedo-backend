-- Hardware library records are created from the admin panel and stored entirely in the database;
-- each one gets a pgvector embedding of its canonical facts for Prototype retrieval (plan D4).
-- Additive only.
ALTER TABLE "hardware_entities" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
ALTER TABLE "hardware_entities" ADD COLUMN IF NOT EXISTS "embedding_source_summary" TEXT;
ALTER TABLE "hardware_entities" ADD COLUMN IF NOT EXISTS "embedding_model_version" VARCHAR(80);
ALTER TABLE "hardware_entities" ADD COLUMN IF NOT EXISTS "embedding_input_hash" VARCHAR(80);
ALTER TABLE "hardware_entities" ADD COLUMN IF NOT EXISTS "embedded_at" TIMESTAMP(6);

-- HNSW rather than ivfflat: recall is good from the first row (ivfflat lists need thousands of rows).
CREATE INDEX IF NOT EXISTS "hardware_entities_embedding_hnsw"
  ON "hardware_entities" USING hnsw ("embedding" vector_cosine_ops);
