CREATE TABLE publication_retries (
  job_id TEXT PRIMARY KEY REFERENCES publication_inputs(job_id) ON DELETE CASCADE,
  parent_job_id TEXT NOT NULL UNIQUE REFERENCES publication_inputs(job_id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*')
);
CREATE TRIGGER publication_retry_binding BEFORE INSERT ON publication_retries
WHEN NOT EXISTS (
  SELECT 1 FROM publish_jobs child JOIN publication_inputs ci ON ci.job_id=child.id
  JOIN publish_jobs parent ON parent.id=NEW.parent_job_id
  JOIN publication_inputs pi ON pi.job_id=parent.id
  JOIN publication_runs pr ON pr.job_id=parent.id
  LEFT JOIN publication_retries prior ON prior.job_id=parent.id
  WHERE child.id=NEW.job_id AND child.environment='staging' AND parent.environment='staging'
    AND parent.status='cancelled' AND pr.deploy_authorized_at IS NULL
    AND child.candidate_json=parent.candidate_json AND child.candidate_checksum=parent.candidate_checksum
    AND child.base_sha=COALESCE(parent.result_sha,parent.base_sha)
    AND ci.draft_id=pi.draft_id AND ci.revision_id=pi.revision_id AND ci.workflow_revision=pi.workflow_revision
    AND NEW.attempt=COALESCE(prior.attempt,0)+1
)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RETRY_MISMATCH'); END;
CREATE TRIGGER publication_retry_immutable BEFORE UPDATE ON publication_retries
BEGIN SELECT RAISE(ABORT,'PUBLICATION_INPUT_IMMUTABLE'); END;
