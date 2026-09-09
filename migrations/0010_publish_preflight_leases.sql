CREATE TABLE publish_preflights (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 100),
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  revision_checksum TEXT NOT NULL CHECK (length(revision_checksum) = 64 AND revision_checksum NOT GLOB '*[^a-f0-9]*'),
  candidate_checksum TEXT CHECK (candidate_checksum IS NULL OR (length(candidate_checksum) = 64 AND candidate_checksum NOT GLOB '*[^a-f0-9]*')),
  schema_version INTEGER CHECK (schema_version IS NULL OR schema_version > 0),
  renderer_version TEXT,
  renderer_contract_checksum TEXT NOT NULL CHECK (length(renderer_contract_checksum) = 64 AND renderer_contract_checksum NOT GLOB '*[^a-f0-9]*'),
  validated_base_sha TEXT CHECK (validated_base_sha IS NULL OR (length(validated_base_sha) = 40 AND validated_base_sha NOT GLOB '*[^a-f0-9]*')),
  file_count INTEGER CHECK (file_count IS NULL OR file_count > 0),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 100),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  CHECK (
    (status = 'passed' AND candidate_checksum IS NOT NULL AND schema_version IS NOT NULL AND renderer_version IS NOT NULL AND validated_base_sha IS NOT NULL AND file_count IS NOT NULL AND failure_code IS NULL)
    OR
    (status = 'failed' AND candidate_checksum IS NULL AND schema_version IS NULL AND renderer_version IS NULL AND validated_base_sha IS NULL AND file_count IS NULL AND failure_code IS NOT NULL)
  )
);

CREATE INDEX publish_preflights_draft_completed
  ON publish_preflights(draft_id, completed_at DESC, id DESC);
CREATE INDEX publish_preflights_revision_contract
  ON publish_preflights(draft_id, revision_id, revision_checksum, renderer_contract_checksum, completed_at DESC);

ALTER TABLE publish_jobs ADD COLUMN lease_expires_at TEXT;

UPDATE publish_jobs
SET status = 'cancelled', completed_at = COALESCE(completed_at, requested_at)
WHERE environment = 'staging'
  AND status = 'queued'
  AND (
    EXISTS (
      SELECT 1 FROM publish_jobs active
      WHERE active.environment = 'staging' AND active.status = 'running'
    )
    OR id != (
      SELECT id FROM publish_jobs latest
      WHERE latest.environment = 'staging' AND latest.status = 'queued'
      ORDER BY requested_at DESC, id DESC LIMIT 1
    )
  );

UPDATE publish_jobs
SET lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', requested_at, '+15 minutes')
WHERE environment = 'staging' AND status IN ('queued', 'running');

DROP INDEX one_running_publish_per_environment;
CREATE UNIQUE INDEX one_active_publish_per_environment
  ON publish_jobs(environment)
  WHERE status IN ('queued', 'running');
