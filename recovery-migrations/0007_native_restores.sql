CREATE TABLE native_restore_runs (
  id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  backup_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('prepared','complete')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE TRIGGER native_restore_identity BEFORE UPDATE ON native_restore_runs
WHEN NEW.id!=OLD.id OR NEW.epoch!=OLD.epoch OR NEW.backup_id!=OLD.backup_id OR NEW.manifest_hash!=OLD.manifest_hash
BEGIN SELECT RAISE(ABORT,'native restore identity is immutable'); END;
