-- Fase 2: RLS e grants das novas tabelas, imutabilidade do relato e anonimato garantido no banco.

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Denúncia nunca é excluída fisicamente (arquivamento = status DISMISSED).
REVOKE DELETE ON complaints FROM app_runtime;
-- Complementos e histórico são somente-inserção.
GRANT SELECT, INSERT ON complaint_addenda, complaint_status_history TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON complaint_comments TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON system_settings TO app_runtime;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE complaint_addenda         ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaint_status_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaint_comments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings           ENABLE ROW LEVEL SECURITY;

CREATE POLICY addenda_tenant  ON complaint_addenda FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY history_tenant  ON complaint_status_history FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY comments_tenant ON complaint_comments FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY settings_tenant ON system_settings FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ── Relato original imutável (doc de negócio §5.2.5) ────────────────────────
-- Nenhum caminho de aplicação altera estes campos, nem ADMIN. A única exceção futura é o job
-- de retenção/anonimização (fase 7), que ganhará um papel de banco próprio e será tratado aqui.
CREATE OR REPLACE FUNCTION complaints_immutable_report() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF (NEW.tenant_id, NEW.protocol, NEW.access_key_hash, NEW.is_anonymous, NEW.reported_type,
      NEW.title, NEW.description, NEW.involved_people, NEW.witnesses, NEW.incident_date,
      NEW.location, NEW.integrity_hash, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.protocol, OLD.access_key_hash, OLD.is_anonymous, OLD.reported_type,
      OLD.title, OLD.description, OLD.involved_people, OLD.witnesses, OLD.incident_date,
      OLD.location, OLD.integrity_hash, OLD.created_by)
  THEN
    RAISE EXCEPTION 'O relato original é imutável; use complemento (addendum)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER complaints_immutable_report BEFORE UPDATE ON complaints
  FOR EACH ROW EXECUTE FUNCTION complaints_immutable_report();

-- ── Anonimato: horário truncado ao minuto, garantido no banco ───────────────
CREATE OR REPLACE FUNCTION complaints_anonymous_time() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.is_anonymous THEN
    NEW.created_at := date_trunc('minute', NEW.created_at);
    NEW.updated_at := date_trunc('minute', NEW.updated_at);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER complaints_anonymous_time BEFORE INSERT OR UPDATE ON complaints
  FOR EACH ROW EXECUTE FUNCTION complaints_anonymous_time();

-- Auditoria de origem anônima: sem IP/UA e horário ao minuto; a ordem é dada por seq (interno).
CREATE OR REPLACE FUNCTION audit_logs_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  IF NEW.anonymous_origin THEN
    NEW.ip_address := NULL;
    NEW.user_agent := NULL;
    NEW.user_id := NULL;
    NEW.timestamp := date_trunc('minute', NEW.timestamp);
  END IF;
  -- seq vem de SEQUENCE por tenant e NÃO é transacional por projeto (buracos benignos em
  -- rollback são esperados e registrados no selo; não "consertar", pois reintroduz lock).
  NEW.seq := nextval(format('audit_seq_%s', replace(NEW.tenant_id::text, '-', ''))::regclass);
  NEW.row_hash := encode(sha256(convert_to(concat_ws('|',
    NEW.tenant_id, NEW.seq, coalesce(NEW.user_id::text, ''), NEW.action::text, NEW.resource,
    coalesce(NEW.resource_id, ''), coalesce(NEW.details::text, ''),
    to_char(NEW.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8')), 'hex');
  RETURN NEW;
END
$$;
