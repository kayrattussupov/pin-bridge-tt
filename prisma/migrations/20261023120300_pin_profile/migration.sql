-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "pin_company_name" TEXT,
ADD COLUMN     "pin_legal_name" TEXT,
ADD COLUMN     "pin_name" TEXT,
ADD COLUMN     "pin_profile_synced_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "pin_seller_name" TEXT;
