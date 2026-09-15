/* Verification owns no deployment authority and retains only immutable public metadata. */
CREATE TABLE publication_verifications (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  job_id TEXT NOT NULL REFERENCES publication_inputs(job_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 16 AND 100),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  target TEXT NOT NULL CHECK(target IN ('staging','production')),
  nonce TEXT NOT NULL UNIQUE CHECK(length(nonce)=64),
  workflow_revision TEXT NOT NULL CHECK(length(workflow_revision)=40),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  original_run_attempt TEXT NOT NULL,
  native_worker_deployment_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','passed','failed')),
  dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_count BETWEEN 0 AND 6),
  dispatch_after TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  dispatch_error TEXT,
  reserved_run_id TEXT,
  reserved_run_attempt TEXT,
  reserved_check_run_id TEXT,
  check_run_id TEXT,
  report_json TEXT CHECK(report_json IS NULL OR json_valid(report_json)),
  completed_at TEXT,
  UNIQUE(job_id,attempt),
  CHECK((reserved_run_id IS NULL AND reserved_run_attempt IS NULL AND reserved_check_run_id IS NULL AND check_run_id IS NULL)
    OR (reserved_run_id IS NOT NULL AND reserved_run_attempt IS NOT NULL AND reserved_check_run_id IS NOT NULL)),
  CHECK(status NOT IN ('running','passed') OR check_run_id IS NOT NULL),
  CHECK(status!='passed' OR report_json IS NOT NULL)
);
CREATE UNIQUE INDEX publication_verification_active ON publication_verifications(job_id)
WHERE status IN ('queued','running');
CREATE INDEX publication_verification_pending ON publication_verifications(dispatch_after,id)
WHERE status='queued' AND reserved_run_id IS NULL;
CREATE TRIGGER publication_verification_input_immutable
BEFORE UPDATE OF job_id,attempt,idempotency_key,request_hash,requested_by,requested_at,target,nonce,workflow_revision,source_json,original_run_attempt,native_worker_deployment_id ON publication_verifications
BEGIN SELECT RAISE(ABORT,'PUBLICATION_VERIFICATION_IMMUTABLE'); END;
CREATE TRIGGER publication_verification_run_immutable
BEFORE UPDATE OF reserved_run_id,reserved_run_attempt,reserved_check_run_id ON publication_verifications
WHEN OLD.reserved_run_id IS NOT NULL AND (NEW.reserved_run_id IS NOT OLD.reserved_run_id
  OR NEW.reserved_run_attempt IS NOT OLD.reserved_run_attempt OR NEW.reserved_check_run_id IS NOT OLD.reserved_check_run_id)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_VERIFICATION_IMMUTABLE'); END;
CREATE TRIGGER publication_verification_check_immutable BEFORE UPDATE OF check_run_id ON publication_verifications
WHEN OLD.check_run_id IS NOT NULL AND NEW.check_run_id IS NOT OLD.check_run_id
BEGIN SELECT RAISE(ABORT,'PUBLICATION_VERIFICATION_IMMUTABLE'); END;
CREATE TRIGGER publication_verification_report_immutable BEFORE UPDATE OF report_json ON publication_verifications
WHEN OLD.report_json IS NOT NULL AND NEW.report_json IS NOT OLD.report_json
BEGIN SELECT RAISE(ABORT,'PUBLICATION_VERIFICATION_IMMUTABLE'); END;
