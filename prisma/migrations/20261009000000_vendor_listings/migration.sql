-- CreateTable
CREATE TABLE "vendor_listings" (
    "listing_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "url" TEXT NOT NULL,
    "store_host" VARCHAR(255) NOT NULL,
    "hardware_entity_id" VARCHAR(64),
    "store_sku" VARCHAR(100),
    "product_name" VARCHAR(300),
    "status" VARCHAR(20) NOT NULL,
    "price" DECIMAL(12,2),
    "currency" VARCHAR(3),
    "stock_state" VARCHAR(20),
    "parse_method" VARCHAR(20),
    "last_error" VARCHAR(300),
    "checked_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_listings_pkey" PRIMARY KEY ("listing_id")
);

-- CreateTable
CREATE TABLE "listing_observations" (
    "observation_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "listing_id" UUID NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "stock_state" VARCHAR(20) NOT NULL,
    "observed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_observations_pkey" PRIMARY KEY ("observation_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_listings_url_key" ON "vendor_listings"("url");

-- CreateIndex
CREATE INDEX "vendor_listings_entity_idx" ON "vendor_listings"("hardware_entity_id");

-- CreateIndex
CREATE INDEX "listing_observations_listing_idx" ON "listing_observations"("listing_id", "observed_at");

-- AddForeignKey
ALTER TABLE "listing_observations" ADD CONSTRAINT "listing_observations_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "vendor_listings"("listing_id") ON DELETE CASCADE ON UPDATE CASCADE;

