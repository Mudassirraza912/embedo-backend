-- Review queue for machine-sourced hardware (scrapers / vendor agent). Nothing scraped enters the
-- library until an admin approves it from the admin panel. Additive only.
CREATE TABLE IF NOT EXISTS "hardware_change_proposals" (
    "proposal_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "hardware_entity_id" VARCHAR(64),
    "proposed_hardware_entity_id" VARCHAR(64),
    "candidate_payload" JSONB NOT NULL,
    "diff" JSONB,
    "change_class" VARCHAR(40) NOT NULL,
    "source_type" VARCHAR(30) NOT NULL,
    "source_reference" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "validation_issues" JSONB NOT NULL,
    "content_hash" VARCHAR(80),
    "proposed_by" VARCHAR(120) NOT NULL,
    "proposed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" VARCHAR(120),
    "reviewed_at" TIMESTAMP(6),
    "review_notes" TEXT,
    CONSTRAINT "hardware_change_proposals_pkey" PRIMARY KEY ("proposal_id"),
    CONSTRAINT "hardware_change_proposals_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'needs_review')),
    CONSTRAINT "hardware_change_proposals_change_class_check" CHECK ("change_class" IN ('new_entity', 'non_structural', 'engineering_sensitive')),
    CONSTRAINT "hardware_change_proposals_source_type_check" CHECK ("source_type" IN ('vendor_agent', 'user', 'import', 'admin'))
);

CREATE INDEX IF NOT EXISTS "hardware_change_proposals_status_idx" ON "hardware_change_proposals"("status", "proposed_at");
CREATE INDEX IF NOT EXISTS "hardware_change_proposals_proposed_idx" ON "hardware_change_proposals"("proposed_hardware_entity_id");
