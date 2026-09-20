-- Ordem por sequência (não por horário): em denúncia anônima os horários vão ao minuto.
-- IDENTITY não exige GRANT em sequence para app_runtime.
ALTER TABLE "complaint_messages" ADD COLUMN "seq" BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE "attachments"        ADD COLUMN "seq" BIGINT GENERATED ALWAYS AS IDENTITY;
