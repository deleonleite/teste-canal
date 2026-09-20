-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SUPER_ADMIN', 'SUPPORT', 'FINANCIAL');

-- CreateEnum
CREATE TYPE "PlatformAuditAction" AS ENUM ('LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'TENANT_CREATED', 'TENANT_SUSPENDED', 'TENANT_REACTIVATED', 'PLAN_CHANGED', 'SUBSCRIPTION_PAYMENT', 'INTERNAL_USER_CREATED', 'INTERNAL_USER_UPDATED', 'INTERNAL_USER_PASSWORD_RESET', 'SETTINGS_CHANGED', 'BREAK_GLASS_REQUESTED', 'BREAK_GLASS_APPROVED', 'BREAK_GLASS_USED', 'TENANT_ADMIN_TEMP_PASSWORD_ISSUED', 'TENANT_INVITE_SENT');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "platform_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret_enc" TEXT,
    "mfa_recovery_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mfa_last_step" INTEGER NOT NULL DEFAULT 0,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by_id" UUID,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID,
    "action" "PlatformAuditAction" NOT NULL,
    "severity" "Severity" NOT NULL DEFAULT 'LOW',
    "resource" TEXT NOT NULL,
    "resource_id" TEXT,
    "tenant_id" UUID,
    "details" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_refresh_tokens_token_hash_key" ON "platform_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "platform_refresh_tokens_user_id_revoked_at_idx" ON "platform_refresh_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "platform_audit_logs_timestamp_idx" ON "platform_audit_logs"("timestamp");

-- CreateIndex
CREATE INDEX "platform_audit_logs_actor_id_idx" ON "platform_audit_logs"("actor_id");

-- AddForeignKey
ALTER TABLE "platform_refresh_tokens" ADD CONSTRAINT "platform_refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Papel platform_admin: só estas tabelas + tenants/branding; NUNCA conteúdo de denúncia ────────────────────
GRANT SELECT, INSERT, UPDATE ON platform_users, platform_refresh_tokens TO platform_admin;
GRANT SELECT, INSERT ON platform_audit_logs TO platform_admin;
REVOKE ALL ON platform_users, platform_refresh_tokens, platform_audit_logs FROM app_runtime;

-- A auditoria de plataforma é append-only para TODOS (inclusive o dono do schema).
CREATE OR REPLACE FUNCTION platform_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'platform_audit_logs é somente de acréscimo'; END $$;
CREATE TRIGGER platform_audit_no_update BEFORE UPDATE OR DELETE ON platform_audit_logs
  FOR EACH ROW EXECUTE FUNCTION platform_audit_immutable();

-- Contagens por empresa para o painel: só NÚMEROS. É a única janela do platform_admin para as tabelas de
-- conteúdo, e ela não devolve nenhuma coluna de conteúdo (garantia do §3 da arquitetura).
CREATE OR REPLACE FUNCTION platform_tenant_stats()
  RETURNS TABLE (tenant_id uuid, user_count integer, complaint_count integer, complaints_this_month integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT t.id,
    (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.is_active),
    (SELECT count(*)::int FROM complaints c WHERE c.tenant_id = t.id),
    (SELECT count(*)::int FROM complaints c WHERE c.tenant_id = t.id AND c.created_at >= date_trunc('month', now()))
  FROM tenants t
$$;
REVOKE ALL ON FUNCTION platform_tenant_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_tenant_stats() TO platform_admin;
