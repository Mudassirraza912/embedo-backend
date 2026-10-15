-- CreateTable
CREATE TABLE "design_proposals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "base_version_tag" VARCHAR(20),
    "version_tag" VARCHAR(20),
    "change_summary" TEXT NOT NULL,
    "applied_changes" TEXT[],
    "design_graph" JSONB NOT NULL,
    "architecture" JSONB NOT NULL,
    "card" JSONB NOT NULL,
    "message_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(6),

    CONSTRAINT "design_proposals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "design_proposals_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'outdated'))
);

-- CreateIndex
CREATE INDEX "design_proposals_session_status_idx" ON "design_proposals"("session_id", "status");

-- AddForeignKey
ALTER TABLE "design_proposals" ADD CONSTRAINT "design_proposals_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "design_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

