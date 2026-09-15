CREATE TABLE publication_recovery_receipts (
  idempotency_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('retry','cancel')),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX publication_recovery_receipts_job ON publication_recovery_receipts(job_id);
CREATE TRIGGER publication_recovery_receipt_immutable BEFORE UPDATE ON publication_recovery_receipts
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RECOVERY_RECEIPT_IMMUTABLE'); END;
