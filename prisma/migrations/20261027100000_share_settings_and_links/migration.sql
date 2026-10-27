ALTER TABLE "users"
  ADD COLUMN "share_visibility" VARCHAR(10),
  ADD COLUMN "share_expiration" VARCHAR(10),
  ADD CONSTRAINT "users_share_settings_valid_check" CHECK (
    ("share_visibility" IS NULL OR "share_visibility" IN ('public', 'private'))
    AND ("share_expiration" IS NULL OR "share_expiration" IN ('24h', '7d', '30d', 'never'))
    AND ("share_visibility" IS NULL OR "share_expiration" IS NOT NULL)
  );

CREATE TABLE "share_links" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "session_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "target_type" VARCHAR(20) NOT NULL,
  "visibility" VARCHAR(10),
  "expiration_policy" VARCHAR(10),
  "issued_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(6),
  "revoked_at" TIMESTAMP(6),
  CONSTRAINT "share_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "share_links_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "share_links_session_fkey" FOREIGN KEY ("session_id") REFERENCES "design_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "share_links_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "share_links_target_type_check" CHECK ("target_type" IN ('project', 'artifact')),
  CONSTRAINT "share_links_visibility_check" CHECK ("visibility" IS NULL OR "visibility" IN ('public', 'private')),
  CONSTRAINT "share_links_expiration_policy_check" CHECK ("expiration_policy" IS NULL OR "expiration_policy" IN ('24h', '7d', '30d', 'never'))
);

CREATE INDEX "share_links_session_idx" ON "share_links"("session_id");
CREATE INDEX "share_links_user_idx" ON "share_links"("user_id");
