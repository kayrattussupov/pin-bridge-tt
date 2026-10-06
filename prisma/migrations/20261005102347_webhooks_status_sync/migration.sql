/*
  Warnings:

  - The required column `event_id` was added to the `webhook_outbox` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "next_status_check_at" TIMESTAMP(3),
ADD COLUMN     "status_checked_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "webhook_outbox" ADD COLUMN     "event_id" UUID NOT NULL,
ADD COLUMN     "last_status" INTEGER;

-- CreateIndex
CREATE INDEX "listings_next_status_check_at_idx" ON "listings"("next_status_check_at");
