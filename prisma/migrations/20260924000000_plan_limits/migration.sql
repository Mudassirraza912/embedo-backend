-- Admin-editable usage limits per plan, plus per-user overrides. Additive only.
CREATE TABLE "plan_limits" (
  "plan"                     VARCHAR(20) NOT NULL,
  "messages_per_session"     INTEGER     NOT NULL,
  "max_in_flight_sessions"   INTEGER     NOT NULL DEFAULT 0,
  "sessions_per_hour"        INTEGER     NOT NULL,
  "updated_by"               UUID,
  "updated_at"               TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_limits_pkey" PRIMARY KEY ("plan")
);

ALTER TABLE "users" ADD COLUMN "plan_override"   VARCHAR(20);
ALTER TABLE "users" ADD COLUMN "limit_overrides" JSONB;

-- Seed with the values that were previously hard-coded, so behaviour is unchanged until an admin edits them.
INSERT INTO "plan_limits" ("plan", "messages_per_session", "max_in_flight_sessions", "sessions_per_hour") VALUES
  ('guest',   6, 0,  5),
  ('free',   20, 3, 20),
  ('paid',  500, 0, 20)
ON CONFLICT ("plan") DO NOTHING;
