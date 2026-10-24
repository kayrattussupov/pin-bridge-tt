-- CreateTable
CREATE TABLE "pin_responses" (
    "id" BIGSERIAL NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "connection_id" UUID,
    "item_id" TEXT,
    "attempt" INTEGER NOT NULL,
    "http_status" INTEGER,
    "outcome" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pin_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pin_responses_created_at_idx" ON "pin_responses"("created_at");

-- CreateIndex
CREATE INDEX "pin_responses_connection_id_created_at_idx" ON "pin_responses"("connection_id", "created_at");

-- CreateIndex
CREATE INDEX "pin_responses_item_id_idx" ON "pin_responses"("item_id");
