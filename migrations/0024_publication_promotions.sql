CREATE TABLE publication_promotions (
  job_id TEXT PRIMARY KEY REFERENCES publication_inputs(job_id) ON DELETE CASCADE,
  staging_job_id TEXT NOT NULL REFERENCES publication_inputs(job_id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE RESTRICT,
  artifact_digest TEXT NOT NULL CHECK(length(artifact_digest)=64 AND artifact_digest NOT GLOB '*[^a-f0-9]*'),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*')
);
CREATE INDEX publication_promotions_source ON publication_promotions(staging_job_id);
CREATE INDEX publication_promotions_approval ON publication_promotions(approval_id);
CREATE TRIGGER publication_promotion_binding BEFORE INSERT ON publication_promotions
WHEN NOT EXISTS (
  SELECT 1 FROM publication_inputs pi JOIN publish_jobs j ON j.id=pi.job_id
  JOIN publication_inputs source ON source.job_id=NEW.staging_job_id
  JOIN publish_jobs staging ON staging.id=source.job_id
  JOIN approvals a ON a.id=NEW.approval_id
  WHERE pi.job_id=NEW.job_id AND j.environment='production-merge'
    AND staging.environment='staging' AND staging.status='succeeded'
    AND pi.draft_id=source.draft_id AND pi.revision_id=source.revision_id
    AND pi.workflow_revision=source.workflow_revision
    AND j.candidate_json=staging.candidate_json AND j.candidate_checksum=staging.candidate_checksum
    AND a.gate='staging-acceptance' AND a.publish_job_id=staging.id AND a.decision='approved'
    AND a.candidate_checksum=j.candidate_checksum AND a.production_base_sha=j.base_sha
    AND a.staging_commit_sha=staging.result_sha
    AND json_extract(a.candidate_json,'$.publicationProtocol')=2
    AND json_extract(a.candidate_json,'$.workflowRevision')=pi.workflow_revision
    AND json_extract(a.candidate_json,'$.artifactDigest')=NEW.artifact_digest
    AND a.id=(SELECT id FROM approvals WHERE gate='staging-acceptance' AND publish_job_id=staging.id
      ORDER BY created_at DESC,rowid DESC LIMIT 1)
)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_PROMOTION_MISMATCH'); END;
CREATE TRIGGER publication_promotion_immutable BEFORE UPDATE ON publication_promotions
BEGIN SELECT RAISE(ABORT,'PUBLICATION_INPUT_IMMUTABLE'); END;
