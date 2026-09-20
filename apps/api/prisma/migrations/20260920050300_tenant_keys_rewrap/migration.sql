-- Rotação da chave-mestra: as DEKs são reembrulhadas com a KEK nova (só wrapped_key muda).
GRANT UPDATE (wrapped_key) ON tenant_keys TO app_runtime;
