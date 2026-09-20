-- Fase 4B: cadeia de custódia dos anexos, selos de auditoria e chaves por tenant.

-- ── Anexos: a aplicação só pode mover o arquivo de PENDING para um estado final ─────────────
GRANT UPDATE (sha256_hash, original_sha256_hash, size, scan_detail) ON attachments TO app_runtime;

CREATE OR REPLACE FUNCTION attachments_custody_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  -- O estado de varredura é final: PENDING -> CLEAN/INFECTED/ERROR, e nunca mais muda.
  IF NEW.scan_status IS DISTINCT FROM OLD.scan_status AND OLD.scan_status <> 'PENDING' THEN
    RAISE EXCEPTION 'Estado de varredura é final (%)', OLD.scan_status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Hash/tamanho só mudam UMA vez, na limpeza de metadados, preservando o hash original.
  IF NEW.sha256_hash IS DISTINCT FROM OLD.sha256_hash THEN
    IF OLD.scan_status <> 'PENDING' OR OLD.original_sha256_hash IS NOT NULL
       OR NEW.original_sha256_hash IS DISTINCT FROM OLD.sha256_hash THEN
      RAISE EXCEPTION 'Hash do anexo não pode ser alterado' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.original_sha256_hash IS DISTINCT FROM OLD.original_sha256_hash
        OR NEW.size IS DISTINCT FROM OLD.size THEN
    RAISE EXCEPTION 'Hash original e tamanho só mudam junto com a limpeza' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.metadata_stripped AND NOT OLD.metadata_stripped AND OLD.scan_status <> 'PENDING' THEN
    RAISE EXCEPTION 'Limpeza de metadados só ocorre na varredura' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER attachments_custody_guard BEFORE UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_custody_guard();

-- ── Auditoria: função única de hash (trigger e verificação usam a MESMA) ─────────────────────
CREATE OR REPLACE FUNCTION audit_compute_hash(
  t uuid, s bigint, u uuid, a text, r text, rid text, d jsonb, ts timestamp
) RETURNS text LANGUAGE sql IMMUTABLE AS
$$
  SELECT encode(sha256(convert_to(concat_ws('|', t, s, coalesce(u::text, ''), a, r,
    coalesce(rid, ''), coalesce(d::text, ''), to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'UTF8')), 'hex')
$$;
GRANT EXECUTE ON FUNCTION audit_compute_hash(uuid, bigint, uuid, text, text, text, jsonb, timestamp) TO app_runtime;

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
  -- seq: SEQUENCE por tenant, NÃO transacional por projeto (buracos benignos em rollback são
  -- esperados e registrados no selo; não "consertar", pois reintroduz lock e serialização).
  NEW.seq := nextval(format('audit_seq_%s', replace(NEW.tenant_id::text, '-', ''))::regclass);
  NEW.row_hash := audit_compute_hash(NEW.tenant_id, NEW.seq, NEW.user_id, NEW.action::text,
    NEW.resource, NEW.resource_id, NEW.details, NEW.timestamp);
  RETURN NEW;
END
$$;

-- ── Selamento: a aplicação só pode preencher seal_id (uma vez); o resto do registro é imutável ──
GRANT UPDATE (seal_id) ON audit_logs TO app_runtime;
CREATE OR REPLACE FUNCTION audit_logs_seal_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF (to_jsonb(NEW) - 'seal_id') IS DISTINCT FROM (to_jsonb(OLD) - 'seal_id') OR OLD.seal_id IS NOT NULL THEN
    RAISE EXCEPTION 'Registro de auditoria é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_logs_seal_guard BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_seal_guard();

-- Selos: inserção + preenchimento único da âncora.
GRANT SELECT, INSERT ON audit_seals TO app_runtime;
GRANT UPDATE (anchor_type, anchor_ref, anchored_at) ON audit_seals TO app_runtime;
ALTER TABLE audit_seals ENABLE ROW LEVEL SECURITY;
CREATE POLICY seals_tenant ON audit_seals FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE OR REPLACE FUNCTION audit_seals_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF (to_jsonb(NEW) - 'anchor_type' - 'anchor_ref' - 'anchored_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'anchor_type' - 'anchor_ref' - 'anchored_at')
     OR OLD.anchored_at IS NOT NULL THEN
    RAISE EXCEPTION 'Selo de auditoria é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_seals_guard BEFORE UPDATE ON audit_seals
  FOR EACH ROW EXECUTE FUNCTION audit_seals_guard();

-- ── Chaves de dados por tenant (envelope) ────────────────────────────────────────────────────
GRANT SELECT, INSERT ON tenant_keys TO app_runtime;
GRANT UPDATE (retired_at) ON tenant_keys TO app_runtime;
ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY keys_tenant ON tenant_keys FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
