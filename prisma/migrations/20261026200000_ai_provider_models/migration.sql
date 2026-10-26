-- CreateTable
CREATE TABLE "ai_provider_models" (
    "provider" VARCHAR(50) NOT NULL,
    "model_id" VARCHAR(100) NOT NULL,
    "display_name" VARCHAR(200),
    "provider_created_at" TIMESTAMP(6),
    "selectable" BOOLEAN NOT NULL DEFAULT false,
    "excluded_reason" VARCHAR(200),
    "available" BOOLEAN NOT NULL DEFAULT true,
    "first_seen_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_provider_models_pkey" PRIMARY KEY ("provider","model_id")
);


ALTER TABLE "ai_provider_models" ADD CONSTRAINT "ai_provider_models_provider_check"
  CHECK ("provider" IN ('openai', 'anthropic', 'google'));

-- The admin API's read-only role lists the models for the difficulty routing dropdown.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'embedo_admin_ro') THEN
    EXECUTE 'GRANT SELECT ON ai_provider_models TO embedo_admin_ro';
  END IF;
END $$;
