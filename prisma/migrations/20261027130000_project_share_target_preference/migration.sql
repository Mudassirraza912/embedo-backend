ALTER TABLE "design_sessions"
  ADD COLUMN "share_target_type" VARCHAR(20) NOT NULL DEFAULT 'artifact';

ALTER TABLE "design_sessions"
  ADD CONSTRAINT "design_sessions_share_target_type_check"
  CHECK ("share_target_type" IN ('artifact', 'project'));
