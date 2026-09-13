CREATE TABLE workspace_recovery_runs (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  epoch INTEGER NOT NULL UNIQUE CHECK(epoch>0),
  protected_hash TEXT NOT NULL CHECK(length(protected_hash)=64),
  target_bookmark TEXT NOT NULL,
  previous_bookmark TEXT NOT NULL,
  restored_previous_bookmark TEXT,
  phase TEXT NOT NULL DEFAULT 'prepared' CHECK(phase IN ('prepared','restoring','restored','complete')),
  receipt_cursor TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  CHECK((phase='complete')=(completed_at IS NOT NULL))
);
CREATE TRIGGER workspace_recovery_identity BEFORE UPDATE ON workspace_recovery_runs
WHEN NEW.id!=OLD.id OR NEW.epoch!=OLD.epoch OR NEW.protected_hash!=OLD.protected_hash
 OR NEW.target_bookmark!=OLD.target_bookmark OR NEW.previous_bookmark!=OLD.previous_bookmark
 OR NEW.started_at!=OLD.started_at OR OLD.phase='complete'
 OR (OLD.restored_previous_bookmark IS NOT NULL AND NEW.restored_previous_bookmark IS NOT OLD.restored_previous_bookmark)
BEGIN SELECT RAISE(ABORT,'WORKSPACE_RECOVERY_IMMUTABLE'); END;
