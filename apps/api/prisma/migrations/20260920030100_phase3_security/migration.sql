-- Fase 3: canal seguro do denunciante (mensagens e anexos).

GRANT SELECT, INSERT ON complaint_messages, attachments TO app_runtime;
-- Conteúdo de mensagem é imutável: só a leitura pode ser marcada.
GRANT UPDATE (read_at) ON complaint_messages TO app_runtime;
-- Anexo: só varredura, integridade e exclusão lógica mudam depois do upload.
GRANT UPDATE (scan_status, scanned_at, metadata_stripped, deleted_at, deleted_by) ON attachments TO app_runtime;

ALTER TABLE complaint_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments        ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_tenant ON complaint_messages FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY attachments_tenant ON attachments FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Anonimato: em denúncia anônima, horários de mensagens e anexos vão ao minuto (garantido no banco).
CREATE OR REPLACE FUNCTION complaint_messages_anonymous_time() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM complaints c WHERE c.id = NEW.complaint_id AND c.is_anonymous) THEN
    NEW.created_at := date_trunc('minute', NEW.created_at);
    NEW.read_at := date_trunc('minute', NEW.read_at);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER complaint_messages_anonymous_time BEFORE INSERT OR UPDATE ON complaint_messages
  FOR EACH ROW EXECUTE FUNCTION complaint_messages_anonymous_time();

CREATE OR REPLACE FUNCTION attachments_anonymous_time() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM complaints c WHERE c.id = NEW.complaint_id AND c.is_anonymous) THEN
    NEW.uploaded_at := date_trunc('minute', NEW.uploaded_at);
    NEW.scanned_at := date_trunc('minute', NEW.scanned_at);
    NEW.deleted_at := date_trunc('minute', NEW.deleted_at);
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER attachments_anonymous_time BEFORE INSERT OR UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_anonymous_time();
