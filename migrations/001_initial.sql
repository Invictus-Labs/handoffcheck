-- HandoffCheck store schema v1 (expand-only). History is append-only: UPDATE/DELETE are blocked by triggers
-- except for the drills state projection; retention purge is the only deleter and requires store_meta.purge_mode = '1'.

CREATE TABLE store_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) STRICT;

CREATE TABLE drills (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
  schema_version INTEGER NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_version TEXT NOT NULL,
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  runbook_hash TEXT NOT NULL CHECK (length(runbook_hash) = 64),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  binding_digest TEXT NOT NULL CHECK (length(binding_digest) = 64),
  operator_ref TEXT NOT NULL,
  operator_kind TEXT NOT NULL CHECK (operator_kind IN ('human', 'ai_assisted', 'automated')),
  builder_ref TEXT,
  provider TEXT NOT NULL,
  isolation TEXT NOT NULL CHECK (isolation IN ('vm', 'none')),
  state TEXT NOT NULL CHECK (state IN ('CREATED', 'PREFLIGHT', 'RUNNING', 'COMPLETE', 'FAILED', 'ABORTED', 'CLEANUP_VERIFIED', 'CLEANUP_UNCONFIRMED')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('COMPLETE', 'FAILED', 'ABORTED')),
  outcome_reason TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  retain_until TEXT NOT NULL,
  imported INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0, 1)),
  fault_injected INTEGER NOT NULL DEFAULT 0 CHECK (fault_injected IN (0, 1))
) STRICT;
CREATE INDEX idx_drills_state ON drills (state);
CREATE INDEX idx_drills_binding ON drills (binding_digest);
CREATE INDEX idx_drills_scenario ON drills (workspace_id, scenario_id, created_at);
CREATE INDEX idx_drills_retain ON drills (retain_until);

CREATE TABLE state_transitions (
  drill_id TEXT NOT NULL REFERENCES drills (id),
  seq INTEGER NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (drill_id, seq)
) STRICT;

CREATE TABLE steps (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  drill_id TEXT NOT NULL REFERENCES drills (id),
  schema_version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('install', 'restore', 'rotate', 'recover')),
  deadline_seconds INTEGER NOT NULL,
  mandatory INTEGER NOT NULL CHECK (mandatory IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL', 'TIMEOUT', 'ERROR', 'SKIPPED')),
  reason_code TEXT NOT NULL,
  evidence_hash TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  UNIQUE (drill_id, step_key),
  UNIQUE (drill_id, seq)
) STRICT;
CREATE INDEX idx_steps_drill ON steps (drill_id);

CREATE TABLE interventions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  drill_id TEXT NOT NULL REFERENCES drills (id),
  schema_version INTEGER NOT NULL,
  actor_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  step_key TEXT,
  signature TEXT NOT NULL,
  attestation TEXT NOT NULL
) STRICT;
CREATE INDEX idx_interventions_drill ON interventions (drill_id);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  drill_id TEXT NOT NULL REFERENCES drills (id),
  schema_version INTEGER NOT NULL,
  step_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('manifest', 'preflight_report', 'step_receipt', 'step_log', 'cleanup_receipt', 'run_receipt')),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  redacted INTEGER NOT NULL CHECK (redacted IN (0, 1)),
  redaction_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_evidence_drill ON evidence (drill_id);
CREATE INDEX idx_evidence_sha ON evidence (sha256);

CREATE TABLE cleanup_receipts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  drill_id TEXT NOT NULL REFERENCES drills (id),
  schema_version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  provider TEXT NOT NULL,
  isolation TEXT NOT NULL CHECK (isolation IN ('vm', 'none')),
  status TEXT NOT NULL CHECK (status IN ('VERIFIED', 'UNCONFIRMED')),
  resources TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  note TEXT,
  UNIQUE (drill_id, seq)
) STRICT;
CREATE INDEX idx_cleanup_drill ON cleanup_receipts (drill_id);

-- append-only enforcement ---------------------------------------------------
CREATE TRIGGER state_transitions_no_update BEFORE UPDATE ON state_transitions BEGIN SELECT RAISE(ABORT, 'append-only: state_transitions'); END;
CREATE TRIGGER steps_no_update BEFORE UPDATE ON steps BEGIN SELECT RAISE(ABORT, 'append-only: steps'); END;
CREATE TRIGGER interventions_no_update BEFORE UPDATE ON interventions BEGIN SELECT RAISE(ABORT, 'append-only: interventions'); END;
CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'append-only: evidence'); END;
CREATE TRIGGER cleanup_receipts_no_update BEFORE UPDATE ON cleanup_receipts BEGIN SELECT RAISE(ABORT, 'append-only: cleanup_receipts'); END;

CREATE TRIGGER state_transitions_no_delete BEFORE DELETE ON state_transitions
  WHEN (SELECT v FROM store_meta WHERE k = 'purge_mode') IS NOT '1'
  BEGIN SELECT RAISE(ABORT, 'append-only: state_transitions'); END;
CREATE TRIGGER steps_no_delete BEFORE DELETE ON steps
  WHEN (SELECT v FROM store_meta WHERE k = 'purge_mode') IS NOT '1'
  BEGIN SELECT RAISE(ABORT, 'append-only: steps'); END;
CREATE TRIGGER interventions_no_delete BEFORE DELETE ON interventions
  WHEN (SELECT v FROM store_meta WHERE k = 'purge_mode') IS NOT '1'
  BEGIN SELECT RAISE(ABORT, 'append-only: interventions'); END;
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence
  WHEN (SELECT v FROM store_meta WHERE k = 'purge_mode') IS NOT '1'
  BEGIN SELECT RAISE(ABORT, 'append-only: evidence'); END;
CREATE TRIGGER cleanup_receipts_no_delete BEFORE DELETE ON cleanup_receipts
  WHEN (SELECT v FROM store_meta WHERE k = 'purge_mode') IS NOT '1'
  BEGIN SELECT RAISE(ABORT, 'append-only: cleanup_receipts'); END;
CREATE TRIGGER drills_no_delete BEFORE DELETE ON drills
  WHEN (SELECT v FROM store_meta WHERE k = 'purge_mode') IS NOT '1'
  BEGIN SELECT RAISE(ABORT, 'append-only: drills'); END;

-- drills is the only mutable table, and only its lifecycle projection may change
CREATE TRIGGER drills_immutable_columns BEFORE UPDATE ON drills
  WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.schema_version IS NOT OLD.schema_version
    OR NEW.scenario_id IS NOT OLD.scenario_id OR NEW.scenario_version IS NOT OLD.scenario_version
    OR NEW.artifact_digest IS NOT OLD.artifact_digest OR NEW.runbook_hash IS NOT OLD.runbook_hash
    OR NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.binding_digest IS NOT OLD.binding_digest
    OR NEW.operator_ref IS NOT OLD.operator_ref OR NEW.operator_kind IS NOT OLD.operator_kind
    OR NEW.builder_ref IS NOT OLD.builder_ref OR NEW.provider IS NOT OLD.provider OR NEW.isolation IS NOT OLD.isolation
    OR NEW.created_at IS NOT OLD.created_at OR NEW.retain_until IS NOT OLD.retain_until
    OR NEW.imported IS NOT OLD.imported OR NEW.fault_injected IS NOT OLD.fault_injected
  BEGIN SELECT RAISE(ABORT, 'immutable: drill binding and identity columns'); END;
