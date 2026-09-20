-- CreateEnum
CREATE TYPE "ComplaintSource" AS ENUM ('WEB', 'WHATSAPP', 'PHONE', 'AUDIO', 'EMAIL', 'INTERNAL');

-- CreateEnum
CREATE TYPE "CommentVisibility" AS ENUM ('INTERNAL', 'REPORTER');

-- CreateEnum
CREATE TYPE "AddendumAuthor" AS ENUM ('REPORTER', 'COMMITTEE');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "anonymous_origin" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "complaints" ADD COLUMN     "access_key_hash" TEXT,
ADD COLUMN     "department" TEXT,
ADD COLUMN     "incident_date" DATE,
ADD COLUMN     "integrity_hash" TEXT NOT NULL,
ADD COLUMN     "investigator_id" UUID,
ADD COLUMN     "involved_people" TEXT[],
ADD COLUMN     "location" TEXT,
ADD COLUMN     "reported_type" "ComplaintType" NOT NULL,
ADD COLUMN     "source" "ComplaintSource" NOT NULL DEFAULT 'WEB',
ADD COLUMN     "tags" TEXT[],
ADD COLUMN     "witnesses" TEXT[];

-- CreateTable
CREATE TABLE "complaint_addenda" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "author_type" "AddendumAuthor" NOT NULL,
    "author_id" UUID,
    "content" TEXT NOT NULL,
    "integrity_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "complaint_addenda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaint_status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "previous_status" "ComplaintStatus",
    "new_status" "ComplaintStatus" NOT NULL,
    "changed_by" UUID,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "complaint_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaint_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "visibility" "CommentVisibility" NOT NULL DEFAULT 'INTERNAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "complaint_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "complaint_addenda_complaint_id_idx" ON "complaint_addenda"("complaint_id");

-- CreateIndex
CREATE INDEX "complaint_status_history_complaint_id_idx" ON "complaint_status_history"("complaint_id");

-- CreateIndex
CREATE INDEX "complaint_comments_complaint_id_idx" ON "complaint_comments"("complaint_id");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_tenant_id_key_key" ON "system_settings"("tenant_id", "key");

-- AddForeignKey
ALTER TABLE "complaint_addenda" ADD CONSTRAINT "complaint_addenda_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_addenda" ADD CONSTRAINT "complaint_addenda_complaint_id_fkey" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_status_history" ADD CONSTRAINT "complaint_status_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_status_history" ADD CONSTRAINT "complaint_status_history_complaint_id_fkey" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_comments" ADD CONSTRAINT "complaint_comments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_comments" ADD CONSTRAINT "complaint_comments_complaint_id_fkey" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

