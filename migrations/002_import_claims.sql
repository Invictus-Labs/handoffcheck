-- Imported bundles prove integrity, not provenance: the verdict recorded inside a bundle is kept only as a
-- display-only, unauthenticated claim. The effective verdict of an imported run is always UNKNOWN. Append-only.
CREATE TABLE import_claims (
  drill_id TEXT PRIMARY KEY REFERENCES drills (id),
  claimed_verdict TEXT NOT NULL,
  claimed_json TEXT NOT NULL,
  bundle_sha256 TEXT NOT NULL CHECK (length(bundle_sha256) = 64),
  imported_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER import_claims_no_update BEFORE UPDATE ON import_claims BEGIN SELECT RAISE(ABORT, 'append-only: import_claims'); END;
CREATE TRIGGER import_claims_no_delete BEFORE DELETE ON import_claims
  WHEN (SELECT v FROM store_meta WHERE k = 'purge_mode') IS NOT '1'
  BEGIN SELECT RAISE(ABORT, 'append-only: import_claims'); END;
