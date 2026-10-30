-- CreateTable
CREATE TABLE "support_case_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "case_id" UUID NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_case_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_case_attachments_case_idx" ON "support_case_attachments"("case_id");

-- AddForeignKey
ALTER TABLE "support_case_attachments" ADD CONSTRAINT "support_case_attachments_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "support_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraint
ALTER TABLE "support_case_attachments" ADD CONSTRAINT "support_case_attachments_content_type_check"
  CHECK ("content_type" IN ('image/png', 'image/jpeg', 'image/webp', 'application/pdf'));

ALTER TABLE "support_case_attachments" ADD CONSTRAINT "support_case_attachments_size_check"
  CHECK ("size_bytes" > 0 AND "size_bytes" <= 3145728);

-- Reviewing evidence is the entire point of this table, same reasoning as support_cases itself:
-- no column subset is withheld from the admin read-only role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'embedo_admin_ro') THEN
    EXECUTE 'GRANT SELECT ON support_case_attachments TO embedo_admin_ro';
  END IF;
END $$;
