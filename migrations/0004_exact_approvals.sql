ALTER TABLE approvals ADD COLUMN idempotency_key TEXT;
ALTER TABLE approvals ADD COLUMN publish_job_id TEXT REFERENCES publish_jobs(id) ON DELETE RESTRICT;
ALTER TABLE approvals ADD COLUMN candidate_json TEXT CHECK (candidate_json IS NULL OR json_valid(candidate_json));
ALTER TABLE approvals ADD COLUMN evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json));
ALTER TABLE approvals ADD COLUMN staging_commit_sha TEXT;
ALTER TABLE approvals ADD COLUMN production_base_sha TEXT;

CREATE UNIQUE INDEX approvals_idempotency_key
  ON approvals(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX approvals_job_created
  ON approvals(publish_job_id, created_at DESC);
