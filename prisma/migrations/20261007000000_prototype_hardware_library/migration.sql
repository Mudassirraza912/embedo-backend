-- Prototype mode, first slice of the Prototype Hardware Database (truth file v3.3 §14):
-- product families, hardware entities, their sources and SVG artwork. Additive only.
-- Controlled vocabularies are VARCHAR + CHECK (same approach as design_sessions.status), so an
-- approved future value is a one-line constraint change rather than an enum migration.

-- CreateTable
CREATE TABLE "product_families" (
    "product_family_id" VARCHAR(120) NOT NULL,
    "vendor" VARCHAR(120) NOT NULL,
    "family_name" TEXT NOT NULL,
    "canonical_group" VARCHAR(60) NOT NULL,
    "preferred_hardware_entity_id" VARCHAR(64),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_families_pkey" PRIMARY KEY ("product_family_id")
);

-- CreateTable
CREATE TABLE "hardware_entities" (
    "hardware_entity_id" VARCHAR(64) NOT NULL,
    "product_family_id" VARCHAR(120) NOT NULL,
    "hardware_revision" VARCHAR(60),
    "supersedes" VARCHAR(64),
    "superseded_by" VARCHAR(64),
    "forked_from" VARCHAR(64),
    "review_status" VARCHAR(20) NOT NULL,
    "lifecycle_status" VARCHAR(20) NOT NULL,
    "scope" VARCHAR(20) NOT NULL,
    "verification_method" VARCHAR(30) NOT NULL,
    "record_origin" VARCHAR(30) NOT NULL,
    "asset_readiness" VARCHAR(20) NOT NULL,
    "created_by" VARCHAR(120) NOT NULL,
    "project_id" UUID,
    "promoted_at" TIMESTAMP(6),
    "promoted_by" VARCHAR(120),
    "metadata_schema_version" VARCHAR(10) NOT NULL,
    "last_verified_at" TIMESTAMP(6),
    "content_hash" VARCHAR(80) NOT NULL,
    "metadata_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hardware_entities_pkey" PRIMARY KEY ("hardware_entity_id")
);

-- CreateTable
CREATE TABLE "hardware_sources" (
    "source_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "hardware_entity_id" VARCHAR(64) NOT NULL,
    "source_type" VARCHAR(30) NOT NULL,
    "url" TEXT,
    "official" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(6),
    "last_checked_at" TIMESTAMP(6),
    "content_fingerprint" VARCHAR(100),
    "last_http_status" INTEGER,

    CONSTRAINT "hardware_sources_pkey" PRIMARY KEY ("source_id")
);

-- CreateTable
CREATE TABLE "svg_assets" (
    "hardware_entity_id" VARCHAR(64) NOT NULL,
    "file_name" VARCHAR(120) NOT NULL,
    "storage_path" VARCHAR(255) NOT NULL,
    "build_status" VARCHAR(20) NOT NULL,
    "validation_status" VARCHAR(20) NOT NULL,
    "anchor_ids" JSONB NOT NULL,
    "generation_source_hash" VARCHAR(100) NOT NULL,
    "generated_at" TIMESTAMP(6),
    "approved_by" VARCHAR(120),
    "approved_at" TIMESTAMP(6),
    "artwork_original" BOOLEAN NOT NULL DEFAULT true,
    "svg_markup" TEXT NOT NULL,

    CONSTRAINT "svg_assets_pkey" PRIMARY KEY ("hardware_entity_id")
);

-- CreateIndex
CREATE INDEX "hardware_entities_eligibility_idx" ON "hardware_entities"("scope", "review_status", "asset_readiness");

-- CreateIndex
CREATE INDEX "hardware_entities_family_idx" ON "hardware_entities"("product_family_id");

-- CreateIndex
CREATE INDEX "hardware_entities_project_idx" ON "hardware_entities"("project_id");

-- CreateIndex
CREATE INDEX "hardware_sources_entity_idx" ON "hardware_sources"("hardware_entity_id");

-- Controlled vocabularies (plan Appendix B / validate.py)
ALTER TABLE "hardware_entities" ADD CONSTRAINT "hardware_entities_review_status_check"
  CHECK ("review_status" IN ('provisional', 'confirmed', 'rejected'));
ALTER TABLE "hardware_entities" ADD CONSTRAINT "hardware_entities_lifecycle_status_check"
  CHECK ("lifecycle_status" IN ('active', 'nrnd', 'discontinued', 'unknown'));
ALTER TABLE "hardware_entities" ADD CONSTRAINT "hardware_entities_scope_check"
  CHECK ("scope" IN ('shared_library', 'private_project'));
ALTER TABLE "hardware_entities" ADD CONSTRAINT "hardware_entities_asset_readiness_check"
  CHECK ("asset_readiness" IN ('catalog_only', 'metadata_ready', 'visual_ready', 'wiring_ready', 'needs_review', 'failed'));
ALTER TABLE "hardware_entities" ADD CONSTRAINT "hardware_entities_verification_method_check"
  CHECK ("verification_method" IN ('vendor_live', 'manual_verified', 'verified_third_party', 'generic_reference', 'inferred'));
ALTER TABLE "hardware_entities" ADD CONSTRAINT "hardware_entities_record_origin_check"
  CHECK ("record_origin" IN ('embedo_curated', 'vendor_agent', 'admin_created', 'user_created', 'community_submitted', 'generic_reference'));
-- A private record always belongs to exactly one project (§11); a shared one never does.
ALTER TABLE "hardware_entities" ADD CONSTRAINT "hardware_entities_scope_project_check"
  CHECK (("scope" = 'private_project') = ("project_id" IS NOT NULL));

-- AddForeignKey
ALTER TABLE "hardware_entities" ADD CONSTRAINT "hardware_entities_product_family_id_fkey" FOREIGN KEY ("product_family_id") REFERENCES "product_families"("product_family_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hardware_entities" ADD CONSTRAINT "hardware_entities_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "design_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hardware_sources" ADD CONSTRAINT "hardware_sources_hardware_entity_id_fkey" FOREIGN KEY ("hardware_entity_id") REFERENCES "hardware_entities"("hardware_entity_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "svg_assets" ADD CONSTRAINT "svg_assets_hardware_entity_id_fkey" FOREIGN KEY ("hardware_entity_id") REFERENCES "hardware_entities"("hardware_entity_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Route R: the Prototype resolver (picks library modules and interface-level links). Inserted only
-- when missing, like prisma/seed.ts, so an operator's choice of model is never overwritten.
INSERT INTO "model_routes" ("id", "task_case", "domain", "model_provider", "model_name", "temperature", "max_tokens", "is_active", "updated_at")
SELECT gen_random_uuid(), 'R', NULL, 'openai', 'gpt-4o', 0.10, 4096, true, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "model_routes" WHERE "task_case" = 'R' AND "domain" IS NULL);
