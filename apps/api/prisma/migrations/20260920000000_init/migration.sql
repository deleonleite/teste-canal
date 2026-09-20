-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('PUBLIC', 'REPORTER', 'INVESTIGATOR', 'ADMIN', 'AUDITOR', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ComplaintType" AS ENUM ('HARASSMENT', 'DISCRIMINATION', 'FRAUD', 'CORRUPTION', 'SAFETY', 'ETHICS', 'OTHER');

-- CreateEnum
CREATE TYPE "ComplaintPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'READ', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'EXPORT', 'DOWNLOAD', 'BLOCK', 'UNBLOCK', 'REVEAL_IDENTITY', 'RECUSE', 'REOPEN', 'ACCESS_GRANT', 'LOGIN_FAILED', 'MFA_ENROLL', 'LEGAL_HOLD', 'BREAK_GLASS_PLATFORM', 'EXTERNAL_ACCESS');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'TRIAL',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "max_users" INTEGER NOT NULL DEFAULT 10,
    "max_complaints_per_month" INTEGER NOT NULL DEFAULT 100,
    "subscription_expires_at" TIMESTAMP(3),
    "dpo_name" TEXT,
    "dpo_email" TEXT,
    "escalation_recipient_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_brandings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "company_name" TEXT NOT NULL,
    "primary_color" TEXT NOT NULL DEFAULT '#3b82f6',
    "secondary_color" TEXT NOT NULL DEFAULT '#f59e0b',
    "logo_url" TEXT,
    "favicon_url" TEXT,
    "login_background_url" TEXT,
    "custom_css" TEXT,
    "custom_domain" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_brandings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'PUBLIC',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "blocked_reason" TEXT,
    "blocked_at" TIMESTAMP(3),
    "blocked_by" UUID,
    "last_login_at" TIMESTAMP(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "deactivated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "protocol" TEXT NOT NULL,
    "is_anonymous" BOOLEAN NOT NULL,
    "type" "ComplaintType" NOT NULL,
    "priority" "ComplaintPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "ComplaintStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "action" "AuditAction" NOT NULL,
    "resource" TEXT NOT NULL,
    "resource_id" TEXT,
    "details" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq" BIGINT NOT NULL DEFAULT 0,
    "row_hash" TEXT NOT NULL DEFAULT '',
    "seal_id" UUID,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_brandings_tenant_id_key" ON "tenant_brandings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_brandings_custom_domain_key" ON "tenant_brandings"("custom_domain");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "complaints_protocol_key" ON "complaints"("protocol");

-- CreateIndex
CREATE INDEX "complaints_tenant_id_status_idx" ON "complaints"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_timestamp_idx" ON "audit_logs"("tenant_id", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_tenant_id_seq_key" ON "audit_logs"("tenant_id", "seq");

-- AddForeignKey
ALTER TABLE "tenant_brandings" ADD CONSTRAINT "tenant_brandings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

