-- CreateEnum
CREATE TYPE "AnchorType" AS ENUM ('TSA_RFC3161', 'WORM_BUCKET');

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "original_sha256_hash" TEXT,
ADD COLUMN     "scan_detail" TEXT;

-- CreateTable
CREATE TABLE "audit_seals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "from_seq" BIGINT NOT NULL,
    "to_seq" BIGINT NOT NULL,
    "gaps" BIGINT[],
    "row_count" INTEGER NOT NULL,
    "merkle_root" TEXT NOT NULL,
    "prev_seal_hash" TEXT,
    "seal_hash" TEXT NOT NULL,
    "sealed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anchor_type" "AnchorType",
    "anchor_ref" TEXT,
    "anchored_at" TIMESTAMP(3),

    CONSTRAINT "audit_seals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "wrapped_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "tenant_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_seals_tenant_id_to_seq_key" ON "audit_seals"("tenant_id", "to_seq");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_keys_tenant_id_version_key" ON "tenant_keys"("tenant_id", "version");

-- AddForeignKey
ALTER TABLE "audit_seals" ADD CONSTRAINT "audit_seals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_keys" ADD CONSTRAINT "tenant_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

