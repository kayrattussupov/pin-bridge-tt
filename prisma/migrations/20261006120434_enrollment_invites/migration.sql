-- CreateTable
CREATE TABLE "enrollment_invites" (
    "id" UUID NOT NULL,
    "code_prefix" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "agency_name" TEXT NOT NULL,
    "agency_slug" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "client_request_hash" TEXT,
    "agency_id" UUID,
    "revoked_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enrollment_invites_code_prefix_key" ON "enrollment_invites"("code_prefix");

-- AddForeignKey
ALTER TABLE "enrollment_invites" ADD CONSTRAINT "enrollment_invites_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "agencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
