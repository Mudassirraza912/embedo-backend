-- EKAB: Track B domain intelligence store (Canonical Output & EKAB Ingestion Contract v0.1, §14),
-- plus the admin-managed source allowlist and the deterministic (no-AI) source scraper's working
-- tables. Additive only. Vocabularies mirror src/modules/ekab/ekab.constants.ts.

-- CreateTable
CREATE TABLE "ekab_releases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "release_id" VARCHAR(80) NOT NULL,
    "schema_version" VARCHAR(40),
    "domain_id" VARCHAR(4),
    "domain_name" VARCHAR(80),
    "batch_id" VARCHAR(120),
    "release_status" VARCHAR(30),
    "ingestion_state" VARCHAR(20) NOT NULL,
    "content_hash" VARCHAR(80) NOT NULL,
    "generated_at" TIMESTAMP(6),
    "source_snapshot_id" VARCHAR(120),
    "producer" JSONB,
    "governance" JSONB,
    "declared_counts" JSONB,
    "computed_counts" JSONB,
    "validation_issues" JSONB NOT NULL,
    "round_trip" JSONB,
    "payload" JSONB NOT NULL,
    "source_manifest" JSONB,
    "gap_registry" JSONB,
    "qa_report" JSONB,
    "completion_report" JSONB,
    "received_by" VARCHAR(120) NOT NULL,
    "received_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staged_at" TIMESTAMP(6),
    "decided_by" VARCHAR(120),
    "decided_at" TIMESTAMP(6),
    "decision_notes" TEXT,

    CONSTRAINT "ekab_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ekab_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "release_pk" UUID NOT NULL,
    "release_id" VARCHAR(80) NOT NULL,
    "record_id" VARCHAR(120) NOT NULL,
    "record_revision" INTEGER,
    "record_type" VARCHAR(40),
    "domain_id" VARCHAR(4),
    "topic" TEXT,
    "title" TEXT,
    "normalized_statement" TEXT,
    "origin" VARCHAR(20),
    "trust_state" VARCHAR(20),
    "confidence" VARCHAR(10),
    "lifecycle_status" VARCHAR(20),
    "supersedes" VARCHAR(120),
    "superseded_by_pk" UUID,
    "applicability" JSONB NOT NULL,
    "content" JSONB NOT NULL,
    "evidence_refs" TEXT[],
    "relationship_refs" TEXT[],
    "tags" TEXT[],
    "qa" JSONB,
    "raw" JSONB NOT NULL,
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "quarantine_reasons" JSONB,
    "embedding" vector(1536),
    "embedding_model_version" VARCHAR(80),
    "embedding_input_hash" VARCHAR(80),
    "embedded_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ekab_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ekab_evidence_sources" (
    "source_id" VARCHAR(160) NOT NULL,
    "source_type" VARCHAR(30),
    "publisher" VARCHAR(300),
    "title" TEXT,
    "document_id" VARCHAR(200),
    "url" TEXT,
    "access_state" VARCHAR(30),
    "first_release_id" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ekab_evidence_sources_pkey" PRIMARY KEY ("source_id")
);

-- CreateTable
CREATE TABLE "ekab_record_evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "record_pk" UUID NOT NULL,
    "evidence_id" VARCHAR(160) NOT NULL,
    "source_id" VARCHAR(160) NOT NULL,
    "source_revision" VARCHAR(120),
    "locator" TEXT,
    "support_type" VARCHAR(30),
    "retrieved_at" VARCHAR(40),

    CONSTRAINT "ekab_record_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ekab_record_conditions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "record_pk" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "text" TEXT NOT NULL,
    "value" JSONB,

    CONSTRAINT "ekab_record_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ekab_relationships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "release_pk" UUID NOT NULL,
    "relationship_id" VARCHAR(120) NOT NULL,
    "type" VARCHAR(40),
    "from_record_id" VARCHAR(120),
    "to_record_id" VARCHAR(120),
    "target_concept" TEXT,
    "conditions" JSONB,
    "raw" JSONB NOT NULL,

    CONSTRAINT "ekab_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ekab_gaps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "release_pk" UUID NOT NULL,
    "gap_id" VARCHAR(120) NOT NULL,
    "domain_id" VARCHAR(4),
    "batch_id" VARCHAR(120),
    "topic" TEXT,
    "question" TEXT,
    "gap_type" VARCHAR(30),
    "severity" VARCHAR(10),
    "status" VARCHAR(25),
    "source_refs" TEXT[],
    "resolution_record_refs" TEXT[],
    "notes" TEXT,
    "raw" JSONB NOT NULL,

    CONSTRAINT "ekab_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ekab_handoffs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "release_pk" UUID NOT NULL,
    "handoff_id" VARCHAR(120) NOT NULL,
    "source_domain" VARCHAR(10),
    "target_domain" VARCHAR(10),
    "source_record_refs" TEXT[],
    "question" TEXT,
    "reason" VARCHAR(60),
    "priority" VARCHAR(20),
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(20),
    "resolution_record_refs" TEXT[],
    "raw" JSONB NOT NULL,

    CONSTRAINT "ekab_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ekab_ingestion_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "release_pk" UUID NOT NULL,
    "state" VARCHAR(20) NOT NULL,
    "actor" VARCHAR(120) NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ekab_ingestion_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ekab_source_domains" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "host" VARCHAR(255) NOT NULL,
    "publisher" VARCHAR(300) NOT NULL,
    "default_source_type" VARCHAR(30) NOT NULL,
    "access_state" VARCHAR(30) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_by" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ekab_source_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ekab_scrape_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "domain_id" VARCHAR(4) NOT NULL,
    "batch_code" VARCHAR(40) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "requested" JSONB NOT NULL,
    "summary" JSONB,
    "error" TEXT,
    "release_id" VARCHAR(80),
    "created_by" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(6),

    CONSTRAINT "ekab_scrape_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ekab_scraped_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "final_url" TEXT,
    "host" VARCHAR(255),
    "status" VARCHAR(20) NOT NULL,
    "block_reason" TEXT,
    "http_status" INTEGER,
    "content_type" VARCHAR(120),
    "source_id" VARCHAR(160),
    "source_type" VARCHAR(30),
    "publisher" VARCHAR(300),
    "title" TEXT,
    "document_id" VARCHAR(200),
    "revision" VARCHAR(120),
    "access_state" VARCHAR(30),
    "fingerprint" VARCHAR(80),
    "page_count" INTEGER,
    "retrieved_at" TIMESTAMP(6),

    CONSTRAINT "ekab_scraped_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ekab_candidates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "document_pk" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "keyword" VARCHAR(20),
    "locator" TEXT NOT NULL,
    "section" TEXT,
    "excerpt" TEXT NOT NULL,
    "values" JSONB,
    "suggested_record_type" VARCHAR(40) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "edited" JSONB,
    "reviewed_by" VARCHAR(120),
    "reviewed_at" TIMESTAMP(6),

    CONSTRAINT "ekab_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ekab_releases_domain_state_idx" ON "ekab_releases"("domain_id", "ingestion_state");

-- CreateIndex
CREATE INDEX "ekab_releases_release_id_idx" ON "ekab_releases"("release_id");

-- CreateIndex
CREATE INDEX "ekab_records_record_idx" ON "ekab_records"("record_id", "record_revision");

-- CreateIndex
CREATE INDEX "ekab_records_reasoning_idx" ON "ekab_records"("domain_id", "lifecycle_status", "trust_state");

-- CreateIndex
CREATE UNIQUE INDEX "ekab_records_release_record_key" ON "ekab_records"("release_pk", "record_id");

-- CreateIndex
CREATE INDEX "ekab_record_evidence_record_idx" ON "ekab_record_evidence"("record_pk");

-- CreateIndex
CREATE INDEX "ekab_record_evidence_source_idx" ON "ekab_record_evidence"("source_id");

-- CreateIndex
CREATE INDEX "ekab_record_conditions_record_idx" ON "ekab_record_conditions"("record_pk");

-- CreateIndex
CREATE INDEX "ekab_relationships_from_idx" ON "ekab_relationships"("from_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "ekab_relationships_release_rel_key" ON "ekab_relationships"("release_pk", "relationship_id");

-- CreateIndex
CREATE UNIQUE INDEX "ekab_gaps_release_gap_key" ON "ekab_gaps"("release_pk", "gap_id");

-- CreateIndex
CREATE UNIQUE INDEX "ekab_handoffs_release_handoff_key" ON "ekab_handoffs"("release_pk", "handoff_id");

-- CreateIndex
CREATE INDEX "ekab_ingestion_events_release_idx" ON "ekab_ingestion_events"("release_pk", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ekab_source_domains_host_key" ON "ekab_source_domains"("host");

-- CreateIndex
CREATE INDEX "ekab_scrape_jobs_status_idx" ON "ekab_scrape_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "ekab_scraped_documents_job_idx" ON "ekab_scraped_documents"("job_id");

-- CreateIndex
CREATE INDEX "ekab_candidates_job_status_idx" ON "ekab_candidates"("job_id", "status");

-- AddForeignKey
ALTER TABLE "ekab_records" ADD CONSTRAINT "ekab_records_release_pk_fkey" FOREIGN KEY ("release_pk") REFERENCES "ekab_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ekab_record_evidence" ADD CONSTRAINT "ekab_record_evidence_record_pk_fkey" FOREIGN KEY ("record_pk") REFERENCES "ekab_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ekab_record_evidence" ADD CONSTRAINT "ekab_record_evidence_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "ekab_evidence_sources"("source_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ekab_record_conditions" ADD CONSTRAINT "ekab_record_conditions_record_pk_fkey" FOREIGN KEY ("record_pk") REFERENCES "ekab_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ekab_relationships" ADD CONSTRAINT "ekab_relationships_release_pk_fkey" FOREIGN KEY ("release_pk") REFERENCES "ekab_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ekab_gaps" ADD CONSTRAINT "ekab_gaps_release_pk_fkey" FOREIGN KEY ("release_pk") REFERENCES "ekab_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ekab_handoffs" ADD CONSTRAINT "ekab_handoffs_release_pk_fkey" FOREIGN KEY ("release_pk") REFERENCES "ekab_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ekab_ingestion_events" ADD CONSTRAINT "ekab_ingestion_events_release_pk_fkey" FOREIGN KEY ("release_pk") REFERENCES "ekab_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ekab_scraped_documents" ADD CONSTRAINT "ekab_scraped_documents_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ekab_scrape_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ekab_candidates" ADD CONSTRAINT "ekab_candidates_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ekab_scrape_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ekab_candidates" ADD CONSTRAINT "ekab_candidates_document_pk_fkey" FOREIGN KEY ("document_pk") REFERENCES "ekab_scraped_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Vocabulary CHECK constraints (NULL passes: invalid values are stored as NULL on quarantined rows).
ALTER TABLE "ekab_releases" ADD CONSTRAINT "ekab_releases_release_status_check" CHECK ("release_status" IN ('DRAFT', 'QA_PENDING', 'REVISION_REQUIRED', 'APPROVED_FOR_INGESTION', 'REJECTED', 'SUPERSEDED'));
ALTER TABLE "ekab_releases" ADD CONSTRAINT "ekab_releases_ingestion_state_check" CHECK ("ingestion_state" IN ('RECEIVED', 'SCHEMA_VALID', 'STAGED', 'QUARANTINED', 'PROMOTED', 'REJECTED', 'SUPERSEDED'));
ALTER TABLE "ekab_releases" ADD CONSTRAINT "ekab_releases_domain_check" CHECK ("domain_id" IN ('B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10'));
ALTER TABLE "ekab_records" ADD CONSTRAINT "ekab_records_record_type_check" CHECK ("record_type" IN ('FACT', 'CONSTRAINT', 'RULE', 'RELATIONSHIP', 'EQUATION', 'DERIVED_MODEL', 'TRADEOFF', 'SELECTION_GUIDANCE', 'DESIGN_RULE', 'IMPLEMENTATION_NOTE', 'VALIDATION_METHOD', 'COMPATIBILITY_PREREQUISITE'));
ALTER TABLE "ekab_records" ADD CONSTRAINT "ekab_records_origin_check" CHECK ("origin" IN ('SOURCE_BASED', 'DERIVED'));
ALTER TABLE "ekab_records" ADD CONSTRAINT "ekab_records_trust_state_check" CHECK ("trust_state" IN ('VERIFIED', 'CONDITIONAL', 'UNRESOLVED', 'REJECTED'));
ALTER TABLE "ekab_records" ADD CONSTRAINT "ekab_records_confidence_check" CHECK ("confidence" IN ('HIGH', 'MEDIUM', 'LOW'));
ALTER TABLE "ekab_records" ADD CONSTRAINT "ekab_records_lifecycle_status_check" CHECK ("lifecycle_status" IN ('ACTIVE', 'SUPERSEDED', 'RETIRED'));
ALTER TABLE "ekab_evidence_sources" ADD CONSTRAINT "ekab_evidence_sources_source_type_check" CHECK ("source_type" IN ('STANDARD', 'DATASHEET', 'REFERENCE_MANUAL', 'APP_NOTE', 'REFERENCE_DESIGN', 'OFFICIAL_DOC', 'OFFICIAL_REPO', 'OFFICIAL_WEB', 'PEER_REVIEWED', 'OTHER_APPROVED'));
ALTER TABLE "ekab_evidence_sources" ADD CONSTRAINT "ekab_evidence_sources_access_state_check" CHECK ("access_state" IN ('PUBLIC', 'LICENSED_REFERENCE_ONLY', 'RESTRICTED', 'REQUIRES_REVIEW'));
ALTER TABLE "ekab_record_evidence" ADD CONSTRAINT "ekab_record_evidence_support_type_check" CHECK ("support_type" IN ('DIRECT', 'SUPPORTING', 'CONFLICTING', 'DERIVATION_INPUT'));
ALTER TABLE "ekab_record_conditions" ADD CONSTRAINT "ekab_record_conditions_kind_check" CHECK ("kind" IN ('applies_to', 'excludes', 'condition'));
ALTER TABLE "ekab_relationships" ADD CONSTRAINT "ekab_relationships_type_check" CHECK ("type" IN ('DEPENDS_ON', 'IMPLEMENTS_WITH', 'CONSTRAINS', 'ALTERNATIVE_TO', 'REQUIRES_VALIDATION_WITH', 'SUPERSEDES', 'RELATED_TO'));
ALTER TABLE "ekab_gaps" ADD CONSTRAINT "ekab_gaps_gap_type_check" CHECK ("gap_type" IN ('MISSING_SOURCE', 'RESTRICTED_SOURCE', 'INSUFFICIENT_EVIDENCE', 'CONFLICTING_SOURCES', 'OUT_OF_SCOPE', 'NEEDS_MEASUREMENT', 'NEEDS_HUMAN_REVIEW'));
ALTER TABLE "ekab_gaps" ADD CONSTRAINT "ekab_gaps_severity_check" CHECK ("severity" IN ('CRITICAL', 'MAJOR', 'NORMAL', 'LOW'));
ALTER TABLE "ekab_gaps" ADD CONSTRAINT "ekab_gaps_status_check" CHECK ("status" IN ('OPEN', 'BLOCKED', 'DEFERRED', 'RESOLVED', 'ACCEPTED_LIMITATION'));
ALTER TABLE "ekab_ingestion_events" ADD CONSTRAINT "ekab_ingestion_events_state_check" CHECK ("state" IN ('RECEIVED', 'SCHEMA_VALID', 'STAGED', 'QUARANTINED', 'PROMOTED', 'REJECTED', 'SUPERSEDED', 'QA_APPROVED'));
ALTER TABLE "ekab_source_domains" ADD CONSTRAINT "ekab_source_domains_default_source_type_check" CHECK ("default_source_type" IN ('STANDARD', 'DATASHEET', 'REFERENCE_MANUAL', 'APP_NOTE', 'REFERENCE_DESIGN', 'OFFICIAL_DOC', 'OFFICIAL_REPO', 'OFFICIAL_WEB', 'PEER_REVIEWED', 'OTHER_APPROVED'));
ALTER TABLE "ekab_source_domains" ADD CONSTRAINT "ekab_source_domains_access_state_check" CHECK ("access_state" IN ('PUBLIC', 'LICENSED_REFERENCE_ONLY', 'RESTRICTED'));
ALTER TABLE "ekab_scrape_jobs" ADD CONSTRAINT "ekab_scrape_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'ready', 'failed', 'built'));
ALTER TABLE "ekab_scrape_jobs" ADD CONSTRAINT "ekab_scrape_jobs_domain_check" CHECK ("domain_id" IN ('B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10'));
ALTER TABLE "ekab_scraped_documents" ADD CONSTRAINT "ekab_scraped_documents_status_check" CHECK ("status" IN ('fetched', 'blocked', 'failed'));
ALTER TABLE "ekab_candidates" ADD CONSTRAINT "ekab_candidates_kind_check" CHECK ("kind" IN ('normative_sentence', 'parameter_row'));
ALTER TABLE "ekab_candidates" ADD CONSTRAINT "ekab_candidates_status_check" CHECK ("status" IN ('pending', 'accepted', 'rejected'));

-- A release_id is immutable (§12): at most one non-rejected release may carry it. A release that
-- was REJECTED at ingestion never became knowledge, so a corrected resubmission may reuse the id.
CREATE UNIQUE INDEX "ekab_releases_live_release_id_key" ON "ekab_releases"("release_id") WHERE "ingestion_state" <> 'REJECTED';

-- Retrieval index over promoted records (§14.2: a derived index, never the source of truth).
CREATE INDEX "ekab_records_embedding_hnsw" ON "ekab_records" USING hnsw ("embedding" vector_cosine_ops);
