CREATE TABLE native_backup_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  state TEXT NOT NULL CHECK(state IN ('never','running','succeeded','failed')),
  checked_at TEXT,
  last_success_at TEXT,
  last_success_id TEXT
);
INSERT INTO native_backup_state(id,state) VALUES(1,'never');
