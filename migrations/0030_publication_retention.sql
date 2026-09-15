/* A retired request key must never capture another publication. No content or credentials. */
CREATE TABLE publication_tombstones (
  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 16 AND 100),
  job_id TEXT NOT NULL UNIQUE,
  retired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER publication_tombstone_immutable BEFORE UPDATE ON publication_tombstones
BEGIN SELECT RAISE(ABORT,'PUBLICATION_TOMBSTONE_IMMUTABLE'); END;
CREATE TRIGGER publication_tombstone_retained BEFORE DELETE ON publication_tombstones
BEGIN SELECT RAISE(ABORT,'PUBLICATION_TOMBSTONE_IMMUTABLE'); END;
CREATE TRIGGER publication_retired_key BEFORE INSERT ON publish_jobs
WHEN EXISTS(SELECT 1 FROM publication_tombstones WHERE idempotency_key=NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT,'IDEMPOTENCY_CONFLICT'); END;
CREATE INDEX publication_jobs_retention ON publish_jobs(completed_at,id)
WHERE status IN ('succeeded','failed','cancelled');
CREATE INDEX publication_latest_staging ON publish_jobs(completed_at DESC,id DESC)
WHERE environment='staging' AND status='succeeded';
