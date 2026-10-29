-- CreateTable
CREATE TABLE "generation_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "failure_reason" VARCHAR(30) NOT NULL,
    "kept_version" BOOLEAN NOT NULL,
    "occurred_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_attempts_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "generation_attempts" ADD CONSTRAINT "generation_attempts_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "design_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "generation_attempts_session_idx" ON "generation_attempts"("session_id");

-- CreateIndex
CREATE INDEX "generation_attempts_occurred_at_idx" ON "generation_attempts"("occurred_at");

-- CheckConstraint
ALTER TABLE "generation_attempts" ADD CONSTRAINT "generation_attempts_kind_check"
  CHECK ("kind" IN ('first_build', 'revision'));

ALTER TABLE "generation_attempts" ADD CONSTRAINT "generation_attempts_failure_reason_check"
  CHECK ("failure_reason" IN ('provider_or_timeout', 'pipeline_error'));

-- The admin API's read-only role reads this table for Architect/Prototype failed-run analytics.
-- No free text is ever stored here, so the whole table (not a column subset) is safe to grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'embedo_admin_ro') THEN
    EXECUTE 'GRANT SELECT ON generation_attempts TO embedo_admin_ro';
  END IF;
END $$;
