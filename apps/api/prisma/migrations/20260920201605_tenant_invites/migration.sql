-- AlterTable
ALTER TABLE "users" ADD COLUMN     "must_change_password" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "tenant_invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_invites_token_hash_key" ON "tenant_invites"("token_hash");

-- CreateIndex
CREATE INDEX "tenant_invites_tenant_id_created_at_idx" ON "tenant_invites"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "tenant_invites" ADD CONSTRAINT "tenant_invites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Convites do primeiro ADMIN ────────────────────────────────────────────────────────────────────
ALTER TABLE tenant_invites ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON tenant_invites TO platform_admin;
GRANT SELECT, UPDATE ON tenant_invites TO app_runtime;
CREATE POLICY tenant_invites_platform ON tenant_invites FOR ALL TO platform_admin USING (true) WITH CHECK (true);
-- A empresa só enxerga (e consome) os convites da própria empresa, pelo token que recebeu.
CREATE POLICY tenant_invites_tenant ON tenant_invites FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ── Provisionamento pelo painel da plataforma ─────────────────────────────────────────────────────
-- O papel platform_admin NÃO tem GRANT em users nem pode criar SEQUENCE. Esta função (dona: o schema owner)
-- é o ÚNICO caminho: cria tenant + branding + sequence de auditoria + primeiro ADMIN, atomicamente, e devolve
-- só ids. Nunca lê nem devolve conteúdo.
CREATE OR REPLACE FUNCTION platform_provision_tenant(
  p_slug text, p_company text, p_admin_email text, p_admin_name text, p_admin_hash text, p_must_change boolean
) RETURNS TABLE (tenant_id uuid, admin_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  v_tenant uuid;
  v_admin uuid;
BEGIN
  IF p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(p_slug) < 2 OR length(p_slug) > 40 THEN
    RAISE EXCEPTION 'slug inválido' USING ERRCODE = '22023';
  END IF;
  INSERT INTO tenants (slug, updated_at) VALUES (p_slug, now()) RETURNING id INTO v_tenant;
  INSERT INTO tenant_brandings (tenant_id, company_name, updated_at) VALUES (v_tenant, p_company, now());
  EXECUTE format('CREATE SEQUENCE %I', 'audit_seq_' || replace(v_tenant::text, '-', ''));
  INSERT INTO users (tenant_id, email, password_hash, full_name, role, must_change_password, updated_at)
    VALUES (v_tenant, lower(p_admin_email), p_admin_hash, p_admin_name, 'ADMIN', p_must_change, now())
    RETURNING id INTO v_admin;
  RETURN QUERY SELECT v_tenant, v_admin;
END
$$;
REVOKE ALL ON FUNCTION platform_provision_tenant(text, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_provision_tenant(text, text, text, text, text, boolean) TO platform_admin;
