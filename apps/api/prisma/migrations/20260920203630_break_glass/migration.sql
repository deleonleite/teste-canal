-- CreateEnum
CREATE TYPE "BreakGlassScope" AS ENUM ('COMPLAINT', 'ATTACHMENT');

-- CreateEnum
CREATE TYPE "BreakGlassStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'REVOKED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'BREAK_GLASS_ACCESS';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PlatformAuditAction" ADD VALUE 'BREAK_GLASS_DENIED';
ALTER TYPE "PlatformAuditAction" ADD VALUE 'BREAK_GLASS_REVOKED';

-- CreateTable
CREATE TABLE "break_glass_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "scope" "BreakGlassScope" NOT NULL,
    "resource_id" UUID NOT NULL,
    "resource_label" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "ticket_ref" TEXT NOT NULL,
    "status" "BreakGlassStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "break_glass_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "break_glass_uses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "used_by" UUID NOT NULL,
    "used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "break_glass_uses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "break_glass_requests_tenant_id_created_at_idx" ON "break_glass_requests"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "break_glass_requests_status_idx" ON "break_glass_requests"("status");

-- CreateIndex
CREATE INDEX "break_glass_uses_request_id_idx" ON "break_glass_uses"("request_id");

-- AddForeignKey
ALTER TABLE "break_glass_uses" ADD CONSTRAINT "break_glass_uses_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "break_glass_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Quebra de vidro: o painel da plataforma NUNCA lê conteúdo por conta própria. A única porta é a função
-- platform_bg_read, que confere no banco: pedido aprovado por OUTRO SUPER_ADMIN, dentro da janela (≤ 1 h),
-- feito por quem pediu, escopo de UM item — e grava a trilha dos dois lados na mesma transação da leitura.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

-- platform_admin só LÊ os pedidos; toda escrita é pelas funções abaixo (dono do schema).
GRANT SELECT ON break_glass_requests, break_glass_uses TO platform_admin;
REVOKE ALL ON break_glass_requests, break_glass_uses FROM app_runtime;

-- Trilha da EMPRESA (visível ao ADMIN/AUDITOR dela): sem nenhum dado do caso, só quem/por quê/quando.
CREATE OR REPLACE FUNCTION platform_bg_tenant_audit(p_tenant uuid, p_request uuid, p_details jsonb) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  INSERT INTO audit_logs (tenant_id, action, resource, resource_id, details)
  VALUES (p_tenant, 'BREAK_GLASS_PLATFORM', 'break_glass', p_request::text, p_details)
$$;
REVOKE ALL ON FUNCTION platform_bg_tenant_audit(uuid, uuid, jsonb) FROM PUBLIC;

-- 1) Solicitação: resolve o item pelo PROTOCOLO (que o cliente informa) sem devolver conteúdo.
CREATE OR REPLACE FUNCTION platform_bg_create(
  p_tenant uuid, p_scope "BreakGlassScope", p_protocol text, p_filename text, p_requester uuid, p_reason text, p_ticket text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  v_complaint uuid;
  v_resource uuid;
  v_label text;
  v_n integer;
  v_id uuid;
BEGIN
  IF length(trim(p_reason)) < 20 THEN RAISE EXCEPTION 'motivo muito curto' USING ERRCODE = '22023'; END IF;
  IF length(trim(p_ticket)) < 3 THEN RAISE EXCEPTION 'referência do chamado obrigatória' USING ERRCODE = '22023'; END IF;
  SELECT id INTO v_complaint FROM complaints WHERE tenant_id = p_tenant AND protocol = p_protocol;
  IF v_complaint IS NULL THEN RAISE EXCEPTION 'item não encontrado' USING ERRCODE = 'P0002'; END IF;
  IF p_scope = 'COMPLAINT' THEN
    v_resource := v_complaint;
    v_label := p_protocol;
  ELSE
    SELECT count(*) INTO v_n FROM attachments
      WHERE tenant_id = p_tenant AND complaint_id = v_complaint AND filename = p_filename AND deleted_at IS NULL;
    IF v_n = 0 THEN RAISE EXCEPTION 'item não encontrado' USING ERRCODE = 'P0002'; END IF;
    IF v_n > 1 THEN RAISE EXCEPTION 'mais de um anexo com esse nome' USING ERRCODE = '22023'; END IF;
    SELECT id INTO v_resource FROM attachments
      WHERE tenant_id = p_tenant AND complaint_id = v_complaint AND filename = p_filename AND deleted_at IS NULL;
    v_label := p_protocol || ' / ' || p_filename;
  END IF;
  INSERT INTO break_glass_requests (tenant_id, scope, resource_id, resource_label, requested_by, reason, ticket_ref)
    VALUES (p_tenant, p_scope, v_resource, v_label, p_requester, trim(p_reason), trim(p_ticket)) RETURNING id INTO v_id;
  PERFORM platform_bg_tenant_audit(p_tenant, v_id, jsonb_build_object('phase', 'requested', 'scope', p_scope, 'target', v_label));
  RETURN v_id;
END
$$;

-- 2) Aprovação: OUTRO SUPER_ADMIN, janela de 5 a 60 minutos. Avisa os ADMIN da empresa NA HORA (in-app + e-mail).
CREATE OR REPLACE FUNCTION platform_bg_approve(p_id uuid, p_approver uuid, p_minutes integer)
  RETURNS TABLE (tenant_id uuid, expires_at timestamp, target text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  r break_glass_requests%ROWTYPE;
  v_now timestamp := (now() AT TIME ZONE 'UTC');
  v_exp timestamp;
  v_approver text;
  v_requester text;
BEGIN
  SELECT * INTO r FROM break_glass_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pedido não encontrado' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'PENDING' THEN RAISE EXCEPTION 'pedido já decidido' USING ERRCODE = '55000'; END IF;
  IF r.requested_by = p_approver THEN RAISE EXCEPTION 'o aprovador deve ser diferente de quem pediu' USING ERRCODE = '42501'; END IF;
  IF p_minutes < 5 OR p_minutes > 60 THEN RAISE EXCEPTION 'janela deve ter de 5 a 60 minutos' USING ERRCODE = '22023'; END IF;
  SELECT full_name INTO v_approver FROM platform_users WHERE id = p_approver AND is_active AND role = 'SUPER_ADMIN';
  IF v_approver IS NULL THEN RAISE EXCEPTION 'aprovador inválido' USING ERRCODE = '42501'; END IF;
  SELECT full_name INTO v_requester FROM platform_users WHERE id = r.requested_by;
  v_exp := v_now + make_interval(mins => p_minutes);
  UPDATE break_glass_requests SET status = 'APPROVED', approved_by = p_approver, approved_at = v_now, expires_at = v_exp WHERE id = p_id;
  PERFORM platform_bg_tenant_audit(r.tenant_id, p_id, jsonb_build_object(
    'phase', 'approved', 'scope', r.scope, 'target', r.resource_label, 'reason', r.reason, 'ticket', r.ticket_ref,
    'requestedBy', v_requester, 'approvedBy', v_approver, 'expiresAt', v_exp));
  INSERT INTO notifications (tenant_id, user_id, type, title, message, data, related_type, in_app, email_pending)
    SELECT r.tenant_id, u.id, 'BREAK_GLASS_ACCESS', 'Acesso excepcional da plataforma ao seu ambiente',
      format('A equipe da OuviON (%s, aprovado por %s) recebeu acesso temporário a %s. Motivo: %s. O acesso expira em %s minutos e fica registrado na auditoria.',
        v_requester, v_approver, r.resource_label, r.reason, p_minutes),
      jsonb_build_object('requestId', p_id, 'expiresAt', v_exp), 'break_glass', true, true
    FROM users u WHERE u.tenant_id = r.tenant_id AND u.role = 'ADMIN' AND u.is_active;
  RETURN QUERY SELECT r.tenant_id, v_exp, r.resource_label;
END
$$;

-- 3) Recusa/cancelamento (só de pedido ainda pendente).
CREATE OR REPLACE FUNCTION platform_bg_deny(p_id uuid, p_actor uuid, p_note text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE r break_glass_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM break_glass_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pedido não encontrado' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'PENDING' THEN RAISE EXCEPTION 'pedido já decidido' USING ERRCODE = '55000'; END IF;
  UPDATE break_glass_requests SET status = 'DENIED', decision_note = trim(p_note) WHERE id = p_id;
  PERFORM platform_bg_tenant_audit(r.tenant_id, p_id, jsonb_build_object('phase', 'denied', 'scope', r.scope, 'target', r.resource_label));
END
$$;

-- 4) Revogação antecipada (a expiração normal é automática: a leitura confere a janela a cada uso).
CREATE OR REPLACE FUNCTION platform_bg_revoke(p_id uuid, p_actor uuid, p_note text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE r break_glass_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM break_glass_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pedido não encontrado' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'APPROVED' THEN RAISE EXCEPTION 'só é possível revogar um acesso aprovado' USING ERRCODE = '55000'; END IF;
  UPDATE break_glass_requests SET status = 'REVOKED', revoked_at = (now() AT TIME ZONE 'UTC'), decision_note = trim(p_note) WHERE id = p_id;
  PERFORM platform_bg_tenant_audit(r.tenant_id, p_id, jsonb_build_object('phase', 'revoked', 'scope', r.scope, 'target', r.resource_label));
END
$$;

-- 5) LEITURA do item: a ÚNICA porta de conteúdo. Nunca devolve identidade do denunciante, mensagens nem comentários.
CREATE OR REPLACE FUNCTION platform_bg_read(p_id uuid, p_operator uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  r break_glass_requests%ROWTYPE;
  v_now timestamp := (now() AT TIME ZONE 'UTC');
  v_out jsonb;
  v_name text;
BEGIN
  SELECT * INTO r FROM break_glass_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pedido não encontrado' USING ERRCODE = 'P0002'; END IF;
  IF r.requested_by <> p_operator THEN RAISE EXCEPTION 'só quem pediu usa o acesso' USING ERRCODE = '42501'; END IF;
  IF r.status <> 'APPROVED' THEN RAISE EXCEPTION 'acesso não está ativo' USING ERRCODE = '55000'; END IF;
  IF r.expires_at <= v_now THEN RAISE EXCEPTION 'a janela de acesso terminou' USING ERRCODE = '55000'; END IF;

  IF r.scope = 'COMPLAINT' THEN
    SELECT jsonb_build_object('kind', 'COMPLAINT', 'id', c.id, 'protocol', c.protocol, 'type', c.type, 'priority', c.priority,
      'status', c.status, 'title', c.title, 'description', c.description, 'involvedPeople', c.involved_people,
      'witnesses', c.witnesses, 'incidentDate', c.incident_date, 'location', c.location, 'isAnonymous', c.is_anonymous, 'createdAt', c.created_at)
      INTO v_out FROM complaints c WHERE c.id = r.resource_id AND c.tenant_id = r.tenant_id;
  ELSE
    SELECT jsonb_build_object('kind', 'ATTACHMENT', 'id', a.id, 'filename', a.filename, 'mimeType', a.mime_type, 'size', a.size,
      'scanStatus', a.scan_status, 's3Key', a.s3_key, 's3Bucket', a.s3_bucket)
      INTO v_out FROM attachments a WHERE a.id = r.resource_id AND a.tenant_id = r.tenant_id AND a.deleted_at IS NULL;
    IF v_out IS NOT NULL AND v_out->>'scanStatus' <> 'CLEAN' THEN
      RAISE EXCEPTION 'o anexo ainda não foi verificado ou está bloqueado' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF v_out IS NULL THEN RAISE EXCEPTION 'item não está mais disponível' USING ERRCODE = 'P0002'; END IF;

  SELECT full_name INTO v_name FROM platform_users WHERE id = p_operator;
  INSERT INTO break_glass_uses (request_id, used_by) VALUES (p_id, p_operator);
  PERFORM platform_bg_tenant_audit(r.tenant_id, p_id, jsonb_build_object('phase', 'used', 'scope', r.scope, 'target', r.resource_label, 'usedBy', v_name));
  INSERT INTO platform_audit_logs (actor_id, action, severity, resource, resource_id, tenant_id, details)
    VALUES (p_operator, 'BREAK_GLASS_USED', 'CRITICAL', 'break_glass', p_id::text, r.tenant_id,
      jsonb_build_object('scope', r.scope, 'target', r.resource_label, 'ticket', r.ticket_ref));
  RETURN v_out;
END
$$;

REVOKE ALL ON FUNCTION platform_bg_create(uuid, "BreakGlassScope", text, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_bg_approve(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_bg_deny(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_bg_revoke(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_bg_read(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_bg_create(uuid, "BreakGlassScope", text, text, uuid, text, text) TO platform_admin;
GRANT EXECUTE ON FUNCTION platform_bg_approve(uuid, uuid, integer) TO platform_admin;
GRANT EXECUTE ON FUNCTION platform_bg_deny(uuid, uuid, text) TO platform_admin;
GRANT EXECUTE ON FUNCTION platform_bg_revoke(uuid, uuid, text) TO platform_admin;
GRANT EXECUTE ON FUNCTION platform_bg_read(uuid, uuid) TO platform_admin;
