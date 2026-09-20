-- CreateEnum
CREATE TYPE "ConflictMatchType" AS ENUM ('EMAIL', 'NAME');

-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RecusalOrigin" AS ENUM ('SELF', 'AUTOMATIC', 'ADMIN');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "escalation_token_expires_at" TIMESTAMP(3),
ADD COLUMN     "escalation_token_hash" TEXT,
ADD COLUMN     "escalation_totp_enrolled_at" TIMESTAMP(3),
ADD COLUMN     "escalation_totp_secret_enc" TEXT,
ADD COLUMN     "escalation_verified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "complaint_recusals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "declared_by" UUID,
    "origin" "RecusalOrigin" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "complaint_recusals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conflict_flags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "match_type" "ConflictMatchType" NOT NULL,
    "status" "ConflictStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conflict_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaint_access_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "granted_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "complaint_access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_accesses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "recipient_email" TEXT NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "link_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "external_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_reveals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "justification" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_reveals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "complaint_recusals_complaint_id_user_id_key" ON "complaint_recusals"("complaint_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conflict_flags_complaint_id_user_id_key" ON "conflict_flags"("complaint_id", "user_id");

-- CreateIndex
CREATE INDEX "complaint_access_grants_complaint_id_user_id_idx" ON "complaint_access_grants"("complaint_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_accesses_token_hash_key" ON "external_accesses"("token_hash");

-- CreateIndex
CREATE INDEX "external_accesses_complaint_id_idx" ON "external_accesses"("complaint_id");

-- AddForeignKey
ALTER TABLE "complaint_recusals" ADD CONSTRAINT "complaint_recusals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_recusals" ADD CONSTRAINT "complaint_recusals_complaint_id_fkey" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflict_flags" ADD CONSTRAINT "conflict_flags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflict_flags" ADD CONSTRAINT "conflict_flags_complaint_id_fkey" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_access_grants" ADD CONSTRAINT "complaint_access_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_access_grants" ADD CONSTRAINT "complaint_access_grants_complaint_id_fkey" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_accesses" ADD CONSTRAINT "external_accesses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_accesses" ADD CONSTRAINT "external_accesses_complaint_id_fkey" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_reveals" ADD CONSTRAINT "identity_reveals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_reveals" ADD CONSTRAINT "identity_reveals_complaint_id_fkey" FOREIGN KEY ("complaint_id") REFERENCES "complaints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

