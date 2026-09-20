-- Fase 4A: sessões (refresh tokens) e colunas de MFA.
GRANT SELECT, INSERT, UPDATE ON refresh_tokens TO app_runtime;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY refresh_tenant ON refresh_tokens FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
