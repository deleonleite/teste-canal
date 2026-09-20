-- O selamento preenche seal_id (GRANT de coluna + trigger que barra qualquer outra mudança).
-- Sem política de UPDATE o RLS descartava o UPDATE em silêncio (0 linhas).
CREATE POLICY audit_seal_update ON audit_logs FOR UPDATE TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
