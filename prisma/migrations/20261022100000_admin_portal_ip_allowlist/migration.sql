-- Trusted networks for the internal admin portal (admin.embedo.ai).
CREATE TABLE "admin_portal_ip_allowlist" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cidr" VARCHAR(64) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMP(6),
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_portal_ip_allowlist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_portal_ip_allowlist_cidr_key" ON "admin_portal_ip_allowlist"("cidr");

-- Only normalised networks (the API normalises; this stops anything else reaching Nginx).
ALTER TABLE "admin_portal_ip_allowlist" ADD CONSTRAINT "admin_portal_ip_allowlist_cidr_check"
  CHECK ("cidr" = (("cidr")::cidr)::text);

-- The admin API's read-only role, when it exists, may read the list (no other columns).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'embedo_admin_ro') THEN
    EXECUTE 'GRANT SELECT (cidr, enabled, expires_at) ON admin_portal_ip_allowlist TO embedo_admin_ro';
  END IF;
END $$;
