-- CreateTable
CREATE TABLE "status_subscribers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "channel" VARCHAR(20) NOT NULL DEFAULT 'email',
    "target" VARCHAR(255) NOT NULL,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "verify_token" VARCHAR(100),
    "unsubscribe_token" VARCHAR(100),
    "topics" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unsubscribed_at" TIMESTAMP(6),

    CONSTRAINT "status_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "status_subscribers_channel_target_key" ON "status_subscribers"("channel", "target");

-- CreateIndex
CREATE INDEX "status_subscribers_target_idx" ON "status_subscribers"("target");

-- CreateIndex
CREATE INDEX "status_subscribers_active_idx" ON "status_subscribers"("active");
