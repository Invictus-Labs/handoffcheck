-- Orphan recovery: a harness killed mid-run leaves a RUNNING drill. owner_pid/owner_started identify the process that owns
-- the run (pid + start time), and run_inventory records what the run provisioned (written right after provisioning), so
-- `cleanup` can later mark the run ABORTED and verify/remove its resources. Locators stay local (never exported).
ALTER TABLE drills ADD COLUMN owner_pid INTEGER;
ALTER TABLE drills ADD COLUMN owner_started TEXT;

CREATE TABLE run_inventory (
  drill_id TEXT NOT NULL REFERENCES drills (id),
  seq INTEGER NOT NULL,
  provider TEXT NOT NULL,
  resources TEXT NOT NULL,
  PRIMARY KEY (drill_id, seq)
) STRICT;
CREATE TRIGGER run_inventory_no_update BEFORE UPDATE ON run_inventory BEGIN SELECT RAISE(ABORT, 'append-only: run_inventory'); END;
CREATE TRIGGER run_inventory_no_delete BEFORE DELETE ON run_inventory
  WHEN (SELECT v FROM store_meta WHERE k = 'purge_mode') IS NOT '1'
  BEGIN SELECT RAISE(ABORT, 'append-only: run_inventory'); END;
