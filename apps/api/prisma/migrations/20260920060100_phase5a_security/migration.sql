-- Fase 5A: notificações, preferências, alertas de SLA e anonimato dos novos carimbos de tempo.

GRANT SELECT, INSERT, UPDATE ON notifications, user_preferences TO app_runtime;
GRANT SELECT, INSERT ON sla_alerts TO app_runtime;

ALTER TABLE notifications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_alerts        ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_tenant ON notifications FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY preferences_tenant ON user_preferences FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY sla_alerts_tenant ON sla_alerts FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Anonimato: nenhum carimbo fino em denúncia anônima. Inclui os prazos de SLA (derivados do instante
-- da criação: sem truncar, ack_due_at revelaria o segundo exato) e os marcos do encerramento.
CREATE OR REPLACE FUNCTION complaints_anonymous_time() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.is_anonymous THEN
    NEW.created_at        := date_trunc('minute', NEW.created_at);
    NEW.updated_at        := date_trunc('minute', NEW.updated_at);
    NEW.acknowledged_at   := date_trunc('minute', NEW.acknowledged_at);
    NEW.ack_due_at        := date_trunc('minute', NEW.ack_due_at);
    NEW.ack_warn_at       := date_trunc('minute', NEW.ack_warn_at);
    NEW.feedback_due_at   := date_trunc('minute', NEW.feedback_due_at);
    NEW.feedback_warn_at  := date_trunc('minute', NEW.feedback_warn_at);
    NEW.feedback_sent_at  := date_trunc('minute', NEW.feedback_sent_at);
    NEW.sla_paused_at     := date_trunc('minute', NEW.sla_paused_at);
    NEW.resolved_at       := date_trunc('minute', NEW.resolved_at);
    NEW.follow_up_until   := date_trunc('minute', NEW.follow_up_until);
  END IF;
  RETURN NEW;
END
$$;

-- Notificações sobre uma denúncia anônima nascem com horário ao minuto (não denunciam o instante do relato).
CREATE OR REPLACE FUNCTION notifications_anonymous_time() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.related_type = 'complaint' AND NEW.related_id ~ '^[0-9a-f-]{36}$'
     AND EXISTS (SELECT 1 FROM complaints c WHERE c.id = NEW.related_id::uuid AND c.is_anonymous) THEN
    NEW.created_at := date_trunc('minute', NEW.created_at);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER notifications_anonymous_time BEFORE INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_anonymous_time();
