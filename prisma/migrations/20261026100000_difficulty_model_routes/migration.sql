-- AlterTable
ALTER TABLE "ai_calls" ADD COLUMN     "difficulty_score" SMALLINT,
ADD COLUMN     "prompt_difficulty" VARCHAR(10);

-- CreateTable
CREATE TABLE "difficulty_model_routes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_case" CHAR(1) NOT NULL,
    "difficulty" VARCHAR(10) NOT NULL,
    "model_provider" VARCHAR(50) NOT NULL,
    "model_name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" VARCHAR(320),
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "difficulty_model_routes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "difficulty_model_routes_task_case_difficulty_key" ON "difficulty_model_routes"("task_case", "difficulty");


-- Vocabularies mirror src/modules/ai/prompt-classifier.ts (DIFFICULTY_TASK_CASES, PROMPT_DIFFICULTIES)
-- and the providers model-provider.service.ts supports.
ALTER TABLE "difficulty_model_routes" ADD CONSTRAINT "difficulty_model_routes_task_case_check"
  CHECK ("task_case" IN ('A', 'R', 'E'));
ALTER TABLE "difficulty_model_routes" ADD CONSTRAINT "difficulty_model_routes_difficulty_check"
  CHECK ("difficulty" IN ('easy', 'medium', 'hard'));
ALTER TABLE "difficulty_model_routes" ADD CONSTRAINT "difficulty_model_routes_provider_check"
  CHECK ("model_provider" IN ('openai', 'anthropic', 'google'));
ALTER TABLE "difficulty_model_routes" ADD CONSTRAINT "difficulty_model_routes_model_name_check"
  CHECK ("model_name" ~ '^[A-Za-z0-9._:@-]{1,100}$');
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_prompt_difficulty_check"
  CHECK ("prompt_difficulty" IS NULL OR "prompt_difficulty" IN ('easy', 'medium', 'hard'));

-- Admin API roles, when they exist (scripts/server/*.sql in embedo-Dashboard-Backend):
--  * embedo_admin_ro reads the table and the new ai_calls metering columns;
--  * embedo_admin_routing_rw may only read and write this one table (no DELETE: a route is
--    switched off with is_active = false).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'embedo_admin_ro') THEN
    EXECUTE 'GRANT SELECT ON difficulty_model_routes TO embedo_admin_ro';
    EXECUTE 'GRANT SELECT (prompt_difficulty, difficulty_score) ON ai_calls TO embedo_admin_ro';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'embedo_admin_routing_rw') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON difficulty_model_routes TO embedo_admin_routing_rw';
  END IF;
END $$;
