-- CreateTable
CREATE TABLE "system_secrets" (
    "name" TEXT NOT NULL,
    "value_enc" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_secrets_pkey" PRIMARY KEY ("name")
);
