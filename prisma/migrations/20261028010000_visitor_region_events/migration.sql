-- CreateTable
CREATE TABLE "visitor_region_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" VARCHAR(30) NOT NULL,
    "user_id" UUID,
    "anon_session_token" VARCHAR(255),
    "mode" VARCHAR(20),
    "session_id" UUID,
    "country_code" VARCHAR(2),
    "region_code" VARCHAR(10),
    "geo_source" VARCHAR(40) NOT NULL,
    "geo_source_version" VARCHAR(40),
    "geo_status" VARCHAR(10) NOT NULL,
    "observed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_region_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visitor_region_events_observed_at_idx" ON "visitor_region_events"("observed_at");

-- CreateIndex
CREATE INDEX "visitor_region_events_user_idx" ON "visitor_region_events"("user_id");

-- CreateIndex
CREATE INDEX "visitor_region_events_anon_idx" ON "visitor_region_events"("anon_session_token");

-- CreateIndex
CREATE INDEX "visitor_region_events_country_idx" ON "visitor_region_events"("country_code");

-- CheckConstraint
ALTER TABLE "visitor_region_events" ADD CONSTRAINT "visitor_region_events_event_type_check"
  CHECK ("event_type" IN ('guest_session_init', 'login', 'workspace_entered'));

ALTER TABLE "visitor_region_events" ADD CONSTRAINT "visitor_region_events_mode_check"
  CHECK ("mode" IS NULL OR "mode" IN ('architect', 'prototype'));

ALTER TABLE "visitor_region_events" ADD CONSTRAINT "visitor_region_events_geo_status_check"
  CHECK ("geo_status" IN ('ok', 'unknown'));

-- No raw IP, free text or prompt/content columns are ever written to this table, so the whole table
-- (not a column subset) is safe to grant to the admin API's read-only role. See CLAUDE.md §4.14 /
-- task_two for why: country/region are derived facts, userId/anonSessionToken are the same
-- pseudonymous identity keys already used elsewhere, never an IP address.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'embedo_admin_ro') THEN
    EXECUTE 'GRANT SELECT ON visitor_region_events TO embedo_admin_ro';
  END IF;
END $$;
