-- Independent from the workspace database and its Time Travel restores.
CREATE TABLE workspace_recovery (
  id INTEGER PRIMARY KEY CHECK(id=1),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  mode TEXT NOT NULL CHECK(mode IN ('active','quarantined')),
  leased_until INTEGER NOT NULL DEFAULT 0 CHECK(leased_until>=0),
  recovery_id TEXT,
  CHECK((mode='active' AND recovery_id IS NULL) OR (mode='quarantined' AND length(recovery_id)=36))
);
INSERT INTO workspace_recovery(id,epoch,mode) VALUES (1,1,'active');
