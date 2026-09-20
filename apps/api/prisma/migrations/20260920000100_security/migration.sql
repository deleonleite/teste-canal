-- Papéis de banco (arq. §5.3). Senhas são definidas fora da migration (scripts/db-setup.ts).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_admin') THEN
    CREATE ROLE platform_admin LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_runtime, platform_admin;

-- Tenant atual da transação (definido com SET LOCAL / set_config(..., true) pela aplicação).
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app_current_tenant() TO app_runtime, platform_admin;

-- ── app_runtime: API e worker, sempre sujeitos a RLS ────────────────────────
GRANT SELECT, UPDATE ON tenants TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_brandings, users, complaints TO app_runtime;
-- Auditoria é append-only para a aplicação: sem UPDATE/DELETE.
GRANT SELECT, INSERT ON audit_logs TO app_runtime;

-- ── platform_admin: painel SUPER_ADMIN, sem nenhum GRANT em tabelas de conteúdo ──
GRANT SELECT, INSERT, UPDATE ON tenants, tenant_brandings TO platform_admin;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE tenants          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_brandings ENABLE ROW LEVEL SECURITY;
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs       ENABLE ROW LEVEL SECURITY;
-- Sem FORCE: o dono do schema (migrations/provisionamento e a view abaixo) ignora RLS.

-- Tenants e branding são legíveis antes de existir contexto (resolução por slug/domínio);
-- escrita restrita ao próprio tenant.
CREATE POLICY tenants_read   ON tenants FOR SELECT TO app_runtime USING (true);
CREATE POLICY tenants_update ON tenants FOR UPDATE TO app_runtime
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
CREATE POLICY brandings_read ON tenant_brandings FOR SELECT TO app_runtime USING (true);
CREATE POLICY brandings_write ON tenant_brandings FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

CREATE POLICY tenants_platform    ON tenants          FOR ALL TO platform_admin USING (true) WITH CHECK (true);
CREATE POLICY brandings_platform  ON tenant_brandings FOR ALL TO platform_admin USING (true) WITH CHECK (true);

-- Tabelas de conteúdo: só o tenant da transação.
CREATE POLICY users_tenant      ON users      FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY complaints_tenant ON complaints FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY audit_select      ON audit_logs FOR SELECT TO app_runtime
  USING (tenant_id = app_current_tenant());
CREATE POLICY audit_insert      ON audit_logs FOR INSERT TO app_runtime
  WITH CHECK (tenant_id = app_current_tenant());

-- ── Auditoria: seq e rowHash SEMPRE calculados no banco (arq. §6.2) ──────────
-- SECURITY DEFINER: a aplicação não precisa (nem tem) acesso direto às sequences.
CREATE OR REPLACE FUNCTION audit_logs_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  NEW.seq := nextval(format('audit_seq_%s', replace(NEW.tenant_id::text, '-', ''))::regclass);
  NEW.row_hash := encode(sha256(convert_to(concat_ws('|',
    NEW.tenant_id, NEW.seq, coalesce(NEW.user_id::text, ''), NEW.action::text, NEW.resource,
    coalesce(NEW.resource_id, ''), coalesce(NEW.details::text, ''),
    to_char(NEW.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8')), 'hex');
  RETURN NEW;
END
$$;

CREATE TRIGGER audit_logs_before_insert BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_before_insert();

-- Visão de metadados para o painel da plataforma: sem details, IP, UA, seq ou hash.
CREATE VIEW audit_log_platform_view AS
  SELECT id, tenant_id, user_id, action, resource, resource_id, "timestamp" FROM audit_logs;
GRANT SELECT ON audit_log_platform_view TO platform_admin;
