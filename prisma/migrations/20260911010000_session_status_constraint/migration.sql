-- Normalize the unused legacy default before constraining the column.
UPDATE "design_sessions" SET "status" = 'PENDING' WHERE "status" = 'active';

-- The application state machine is the source of truth; make the database enforce it so a typo
-- or a future code path can never persist an unknown status.
ALTER TABLE "design_sessions" ALTER COLUMN "status" SET DEFAULT 'PENDING';

ALTER TABLE "design_sessions" DROP CONSTRAINT IF EXISTS "design_sessions_status_check";
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_status_check"
  CHECK ("status" IN ('PENDING', 'PROCESSING', 'CLARIFICATION_REQUIRED', 'DONE', 'FAILED', 'SYSTEM'));
