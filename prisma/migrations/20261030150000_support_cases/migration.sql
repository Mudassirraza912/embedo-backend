-- CreateTable
CREATE TABLE "support_cases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_request_id" VARCHAR(100),
    "subcategory" VARCHAR(20) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'new',
    "priority" VARCHAR(10) NOT NULL DEFAULT 'normal',
    "user_id" UUID,
    "guest_contact_email" VARCHAR(255),
    "anon_session_token" VARCHAR(255),
    "mode" VARCHAR(20),
    "session_id" UUID,
    "assigned_agent_email" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_response_at" TIMESTAMP(6),
    "resolved_at" TIMESTAMP(6),

    CONSTRAINT "support_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_case_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "case_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "visible_to_customer" BOOLEAN NOT NULL DEFAULT true,
    "author_label" VARCHAR(255),
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_case_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_cases_client_request_id_key" ON "support_cases"("client_request_id");

-- CreateIndex
CREATE INDEX "support_cases_user_idx" ON "support_cases"("user_id");

-- CreateIndex
CREATE INDEX "support_cases_anon_idx" ON "support_cases"("anon_session_token");

-- CreateIndex
CREATE INDEX "support_cases_status_idx" ON "support_cases"("status");

-- CreateIndex
CREATE INDEX "support_cases_created_at_idx" ON "support_cases"("created_at");

-- CreateIndex
CREATE INDEX "support_case_events_case_idx" ON "support_case_events"("case_id");

-- AddForeignKey
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "design_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_case_events" ADD CONSTRAINT "support_case_events_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "support_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_subcategory_check"
  CHECK ("subcategory" IN ('account', 'credit', 'access', 'bug', 'other'));

ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_status_check"
  CHECK ("status" IN ('new', 'open', 'assigned', 'in_progress', 'waiting_customer', 'resolved', 'closed', 'reopened'));

ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_priority_check"
  CHECK ("priority" IN ('low', 'normal', 'high', 'urgent'));

ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_mode_check"
  CHECK ("mode" IS NULL OR "mode" IN ('architect', 'prototype'));

-- A guest case must carry a contact channel; a signed-in case always has its user_id instead.
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_identity_check"
  CHECK ("user_id" IS NOT NULL OR "guest_contact_email" IS NOT NULL);

ALTER TABLE "support_case_events" ADD CONSTRAINT "support_case_events_kind_check"
  CHECK ("kind" IN ('customer_message', 'admin_response', 'internal_note', 'status_change', 'assignment'));

-- The admin API's read-only role reads these for Support & Feedback case management. Case subject/
-- description/body are customer-submitted free text written specifically for an admin to read (that
-- is the entire purpose of a support case), unlike session prompts/chat which are private product
-- content -- so, unlike those tables, no column subset is withheld here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'embedo_admin_ro') THEN
    EXECUTE 'GRANT SELECT ON support_cases TO embedo_admin_ro';
    EXECUTE 'GRANT SELECT ON support_case_events TO embedo_admin_ro';
  END IF;
END $$;

