-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('FROM_REPORTER', 'TO_REPORTER');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'ERROR');

-- CreateTable
CREATE TABLE "complaint_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "author_id" UUID,
    "content" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "complaint_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "detected_mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "s3_key" TEXT NOT NULL,
    "s3_bucket" TEXT NOT NULL,
    "sha256_hash" TEXT NOT NULL,
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    "scan_status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "scanned_at" TIMESTAMP(3),
    "metadata_stripped" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "complaint_messages_complaint_id_created_at_idx" ON "complaint_messages"("complaint_id", "created_at");

-- CreateIndex
CREATE INDEX "attachments_complaint_id_idx" ON "attachments"("complaint_id");

-- AddForeignKey
ALTER TABLE "complaint_messages" ADD CONSTRAINT "complaint_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_messages" ADD CONSTRAINT "complaint_messages_complaint_id_fkey" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_complaint_id_fkey" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

