CREATE TABLE publication_rollbacks (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  source_release_id TEXT NOT NULL,
  previous_release_id TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json) AND length(source_json)<=8192),
  candidate_checksum TEXT NOT NULL CHECK(length(candidate_checksum)=64),
  base_sha TEXT NOT NULL CHECK(length(base_sha)=40),
  previous_deployment_id TEXT NOT NULL,
  workflow_revision TEXT NOT NULL CHECK(length(workflow_revision)=40),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','cancelled')),
  nonce TEXT NOT NULL CHECK(length(nonce)=64),
  dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_count BETWEEN 0 AND 6),
  dispatch_after TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  reserved_run_id TEXT,
  reserved_run_attempt TEXT,
  reserved_check_run_id TEXT,
  check_run_id TEXT,
  deploy_authorized_at TEXT,
  reported_at TEXT,
  completed_at TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
  CHECK((reserved_run_id IS NULL AND reserved_run_attempt IS NULL AND reserved_check_run_id IS NULL)
    OR (reserved_run_id IS NOT NULL AND reserved_run_attempt IS NOT NULL AND reserved_check_run_id IS NOT NULL)),
  CHECK((status IN ('queued','running') AND completed_at IS NULL)
    OR (status IN ('succeeded','cancelled') AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX publication_rollback_active ON publication_rollbacks((1))
  WHERE status IN ('queued','running');
CREATE INDEX publication_rollback_age ON publication_rollbacks(completed_at,id);
CREATE TRIGGER publication_rollback_retained BEFORE DELETE ON publication_rollbacks
WHEN OLD.status IN ('queued','running') OR OLD.completed_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')
  OR OLD.id IN (SELECT job_id FROM publication_releases ORDER BY sequence DESC LIMIT 2)
BEGIN SELECT RAISE(ABORT,'ROLLBACK_RETAINED'); END;
CREATE TRIGGER publication_rollback_capture BEFORE INSERT ON publication_rollbacks
WHEN EXISTS(SELECT 1 FROM publication_slots WHERE target='production')
  OR EXISTS(SELECT 1 FROM publish_jobs WHERE environment='production-merge' AND status IN ('queued','running'))
  OR EXISTS(SELECT 1 FROM publication_tombstones WHERE idempotency_key=NEW.idempotency_key)
  OR NOT EXISTS(SELECT 1 FROM user_roles WHERE email=NEW.requested_by AND active=1 AND role='administrator')
  OR NEW.previous_release_id IS NOT (SELECT id FROM publication_releases ORDER BY sequence DESC LIMIT 1)
BEGIN SELECT RAISE(ABORT,'ROLLBACK_CAPTURE_CHANGED'); END;
CREATE TRIGGER publication_rollback_exclusive BEFORE INSERT ON publish_jobs
WHEN NEW.environment='production-merge'
  AND EXISTS(SELECT 1 FROM publication_rollbacks WHERE status IN ('queued','running'))
BEGIN SELECT RAISE(ABORT,'PUBLISH_SLOT_BUSY'); END;
CREATE TRIGGER publication_rollback_slot BEFORE INSERT ON publication_slots
WHEN NEW.target='production' AND EXISTS(SELECT 1 FROM publication_rollbacks WHERE status IN ('queued','running'))
BEGIN SELECT RAISE(ABORT,'PUBLISH_SLOT_BUSY'); END;
CREATE TRIGGER publication_rollback_identity BEFORE UPDATE ON publication_rollbacks
WHEN NEW.id!=OLD.id OR NEW.idempotency_key!=OLD.idempotency_key OR NEW.request_hash!=OLD.request_hash
  OR NEW.source_release_id!=OLD.source_release_id OR NEW.previous_release_id!=OLD.previous_release_id
  OR NEW.source_json!=OLD.source_json OR NEW.candidate_checksum!=OLD.candidate_checksum
  OR NEW.base_sha!=OLD.base_sha OR NEW.previous_deployment_id!=OLD.previous_deployment_id
  OR NEW.workflow_revision!=OLD.workflow_revision OR NEW.requested_by!=OLD.requested_by
  OR NEW.requested_at!=OLD.requested_at OR NEW.nonce!=OLD.nonce
  OR (OLD.reserved_run_id IS NOT NULL AND (NEW.reserved_run_id IS NOT OLD.reserved_run_id
    OR NEW.reserved_run_attempt IS NOT OLD.reserved_run_attempt OR NEW.reserved_check_run_id IS NOT OLD.reserved_check_run_id))
  OR (OLD.check_run_id IS NOT NULL AND NEW.check_run_id IS NOT OLD.check_run_id)
  OR (OLD.deploy_authorized_at IS NOT NULL AND NEW.deploy_authorized_at IS NOT OLD.deploy_authorized_at)
  OR (OLD.reported_at IS NOT NULL AND NEW.reported_at IS NOT OLD.reported_at)
  OR OLD.status IN ('succeeded','cancelled')
BEGIN SELECT RAISE(ABORT,'ROLLBACK_IDENTITY_CHANGED'); END;
CREATE TRIGGER publication_rollback_release BEFORE INSERT ON publication_releases
WHEN NEW.kind='rollback' AND NOT EXISTS(
  SELECT 1 FROM publication_rollbacks r WHERE r.id=NEW.id AND NEW.job_id=r.id AND r.status='succeeded'
    AND r.deploy_authorized_at IS NOT NULL AND r.reported_at IS NOT NULL
    AND NEW.previous_release_id=r.previous_release_id
    AND NEW.previous_release_id IS (SELECT id FROM publication_releases ORDER BY sequence DESC LIMIT 1)
    AND NEW.source_json=r.source_json AND NEW.evidence_json=r.evidence_json AND NEW.verified_at=r.completed_at
    AND NEW.artifact_digest=json_extract(r.source_json,'$.artifactDigest')
    AND json_extract(r.evidence_json,'$.artifactDigest')=NEW.artifact_digest
    AND json_extract(r.evidence_json,'$.candidateChecksum')=r.candidate_checksum
    AND json_extract(r.evidence_json,'$.verificationStatus')='passed'
    AND json_extract(r.evidence_json,'$.runId')=r.reserved_run_id
    AND json_extract(r.evidence_json,'$.checkRunId')=r.check_run_id
    AND json_extract(r.evidence_json,'$.workflowRevision')=r.workflow_revision
    AND json_extract(r.evidence_json,'$.commitSha')=r.base_sha
    AND json_extract(r.evidence_json,'$.dispatchRevision')=r.base_sha
)
BEGIN SELECT RAISE(ABORT,'ROLLBACK_RELEASE_MISMATCH'); END;
