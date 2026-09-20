-- CreateEnum
CREATE TYPE "ComplaintConclusion" AS ENUM ('SUBSTANTIATED', 'PARTIALLY_SUBSTANTIATED', 'UNSUBSTANTIATED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('COMPLAINT_CREATED', 'COMPLAINT_ASSIGNED', 'COMPLAINT_STATUS_CHANGED', 'COMPLAINT_COMMENT', 'ATTACHMENT_UPLOADED', 'DOSSIER_GENERATED', 'SYSTEM_ALERT', 'DEADLINE_REMINDER', 'REPORTER_MESSAGE', 'SLA_WARNING', 'SLA_BREACHED', 'CONFLICT_SUSPECTED', 'RECUSAL_REASSIGNED');

-- CreateEnum
CREATE TYPE "SlaKind" AS ENUM ('ACK', 'FEEDBACK');

-- CreateEnum
CREATE TYPE "SlaLevel" AS ENUM ('WARNING', 'BREACHED');

-- AlterTable
ALTER TABLE "complaints" ADD COLUMN     "ack_due_at" TIMESTAMP(3),
ADD COLUMN     "ack_warn_at" TIMESTAMP(3),
ADD COLUMN     "acknowledged_at" TIMESTAMP(3),
ADD COLUMN     "conclusion" "ComplaintConclusion",
ADD COLUMN     "conclusion_notes" TEXT,
ADD COLUMN     "corrective_actions" TEXT,
ADD COLUMN     "feedback_due_at" TIMESTAMP(3),
ADD COLUMN     "feedback_sent_at" TIMESTAMP(3),
ADD COLUMN     "feedback_warn_at" TIMESTAMP(3),
ADD COLUMN     "follow_up_until" TIMESTAMP(3),
ADD COLUMN     "linked_complaint_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "resolved_at" TIMESTAMP(3),
ADD COLUMN     "retaliation_reported" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sla_pause_reason" TEXT,
ADD COLUMN     "sla_paused_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "related_id" TEXT,
    "related_type" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_pending" BOOLEAN NOT NULL DEFAULT false,
    "email_sent" BOOLEAN NOT NULL DEFAULT false,
    "email_sent_at" TIMESTAMP(3),
    "email_error" TEXT,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_notifications" BOOLEAN NOT NULL DEFAULT true,
    "in_app_notifications" BOOLEAN NOT NULL DEFAULT true,
    "email_muted_types" "NotificationType"[] DEFAULT ARRAY[]::"NotificationType"[],
    "in_app_muted_types" "NotificationType"[] DEFAULT ARRAY[]::"NotificationType"[],
    "email_digest" BOOLEAN NOT NULL DEFAULT false,
    "email_digest_time" TEXT NOT NULL DEFAULT '09:00',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "kind" "SlaKind" NOT NULL,
    "level" "SlaLevel" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sla_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_created_at_idx" ON "notifications"("user_id", "is_read", "created_at");

-- CreateIndex
CREATE INDEX "notifications_email_pending_idx" ON "notifications"("email_pending");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_user_id_key" ON "user_preferences"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_alerts_complaint_id_kind_level_key" ON "sla_alerts"("complaint_id", "kind", "level");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_alerts" ADD CONSTRAINT "sla_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

