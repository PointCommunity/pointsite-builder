/* Remains after the deleted draft. Independent recovery settles pending receipts before a rewind. */
CREATE TABLE deletion_commits (
  receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id)=36),
  target_hash TEXT NOT NULL CHECK(length(target_hash)=64),
  committed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER deletion_commit_immutable BEFORE UPDATE ON deletion_commits
BEGIN SELECT RAISE(ABORT,'DELETION_COMMIT_IMMUTABLE'); END;
CREATE TABLE deletion_replays (
  recovery_id TEXT NOT NULL CHECK(length(recovery_id)=36),
  receipt_id TEXT NOT NULL CHECK(length(receipt_id)=36),
  target_hash TEXT NOT NULL CHECK(length(target_hash)=64),
  PRIMARY KEY(recovery_id,receipt_id)
);
CREATE TRIGGER deletion_replay_immutable BEFORE UPDATE ON deletion_replays
BEGIN SELECT RAISE(ABORT,'DELETION_REPLAY_IMMUTABLE'); END;
