-- AlterTable
ALTER TABLE "listing_images" ADD COLUMN     "height" INTEGER,
ADD COLUMN     "width" INTEGER;

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "create_unknown" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "synced_pin_hash" TEXT,
ADD COLUMN     "warnings" JSONB;
