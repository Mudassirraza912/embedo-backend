CREATE TABLE "part_sourcing" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "mpn_key" VARCHAR(128) NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "payload" JSONB NOT NULL,
  "lookup_count" INTEGER NOT NULL DEFAULT 1,
  "fetched_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "part_sourcing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "part_sourcing_mpn_key_key" ON "part_sourcing"("mpn_key");
