-- Fase 2b: conflito de interesses, acesso restrito, acesso externo, revelação de identidade.

GRANT SELECT, INSERT ON complaint_recusals, identity_reveals TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON conflict_flags, complaint_access_grants, external_accesses TO app_runtime;

ALTER TABLE complaint_recusals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_flags           ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaint_access_grants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_accesses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_reveals         ENABLE ROW LEVEL SECURITY;

CREATE POLICY recusals_tenant ON complaint_recusals FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY flags_tenant ON conflict_flags FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY grants_tenant ON complaint_access_grants FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY external_tenant ON external_accesses FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY reveals_tenant ON identity_reveals FOR ALL TO app_runtime
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- A PII cifrada do denunciante também é parte imutável do relato original.
CREATE OR REPLACE FUNCTION complaints_immutable_report() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF (NEW.tenant_id, NEW.protocol, NEW.access_key_hash, NEW.is_anonymous, NEW.reported_type,
      NEW.title, NEW.description, NEW.involved_people, NEW.witnesses, NEW.incident_date,
      NEW.location, NEW.integrity_hash, NEW.created_by,
      NEW.reporter_name_enc, NEW.reporter_email_enc, NEW.reporter_phone_enc)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.protocol, OLD.access_key_hash, OLD.is_anonymous, OLD.reported_type,
      OLD.title, OLD.description, OLD.involved_people, OLD.witnesses, OLD.incident_date,
      OLD.location, OLD.integrity_hash, OLD.created_by,
      OLD.reporter_name_enc, OLD.reporter_email_enc, OLD.reporter_phone_enc)
  THEN
    RAISE EXCEPTION 'O relato original é imutável; use complemento (addendum)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
