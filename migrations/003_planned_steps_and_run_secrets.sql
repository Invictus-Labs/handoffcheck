-- planned_steps: the real number of steps in the manifest, fixed at creation, so a run with fewer recorded steps than
-- planned can never look complete. run_secrets: the run's declared and learned secret literals, AES-256-GCM encrypted
-- under a key derived from the store's identity key, so later writers (interventions, cleanup retries) can redact them.
ALTER TABLE drills ADD COLUMN planned_steps INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER drills_immutable_columns;
CREATE TRIGGER drills_immutable_columns BEFORE UPDATE ON drills
  WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.schema_version IS NOT OLD.schema_version
    OR NEW.scenario_id IS NOT OLD.scenario_id OR NEW.scenario_version IS NOT OLD.scenario_version
    OR NEW.artifact_digest IS NOT OLD.artifact_digest OR NEW.runbook_hash IS NOT OLD.runbook_hash
    OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.binding_digest IS NOT OLD.binding_digest
    OR NEW.operator_ref IS NOT OLD.operator_ref OR NEW.operator_kind IS NOT OLD.operator_kind
    OR NEW.builder_ref IS NOT OLD.builder_ref OR NEW.provider IS NOT OLD.provider OR NEW.isolation IS NOT OLD.isolation
    OR NEW.created_at IS NOT OLD.created_at OR NEW.retain_until IS NOT OLD.retain_until
    OR NEW.imported IS NOT OLD.imported OR NEW.fault_injected IS NOT OLD.fault_injected
    OR NEW.planned_steps IS NOT OLD.planned_steps
  BEGIN SELECT RAISE(ABORT, 'immutable: drill binding and identity columns'); END;

CREATE TABLE run_secrets (
  drill_id TEXT NOT NULL REFERENCES drills (id),
  seq INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (drill_id, seq)
) STRICT;

CREATE TRIGGER run_secrets_no_update BEFORE UPDATE ON run_secrets BEGIN SELECT RAISE(ABORT, 'append-only: run_secrets'); END;
CREATE TRIGGER run_secrets_no_delete BEFORE DELETE ON run_secrets
  WHEN (SELECT v FROM store_meta WHERE k = 'purge_mode') IS NOT '1'
  BEGIN SELECT RAISE(ABORT, 'append-only: run_secrets'); END;
