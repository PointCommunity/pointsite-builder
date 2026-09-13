/* Preserve the original acceptance across a bounded, cancelled retry lineage.
   Job inputs, retry links and promotion links are immutable once inserted. */
DROP TRIGGER publication_retry_binding;
CREATE TRIGGER publication_retry_binding BEFORE INSERT ON publication_retries
WHEN NOT EXISTS (
  SELECT 1 FROM publish_jobs child JOIN publication_inputs ci ON ci.job_id=child.id
  JOIN publish_jobs parent ON parent.id=NEW.parent_job_id
  JOIN publication_inputs pi ON pi.job_id=parent.id
  JOIN publication_runs pr ON pr.job_id=parent.id
  LEFT JOIN publication_retries prior ON prior.job_id=parent.id
  WHERE child.id=NEW.job_id AND child.environment=parent.environment
    AND child.environment IN ('staging','production-merge')
    AND parent.status='cancelled' AND pr.deploy_authorized_at IS NULL
    AND child.candidate_json=parent.candidate_json AND child.candidate_checksum=parent.candidate_checksum
    AND child.base_sha=COALESCE(parent.result_sha,parent.base_sha) AND child.repository=parent.repository
    AND ci.draft_id=pi.draft_id AND ci.revision_id=pi.revision_id AND ci.workflow_revision=pi.workflow_revision
    AND NEW.attempt=COALESCE(prior.attempt,0)+1
    AND (child.environment='staging' OR EXISTS (
      SELECT 1 FROM publication_promotions promotion JOIN approvals accepted ON accepted.id=promotion.approval_id
      WHERE promotion.job_id=parent.id AND accepted.decision='approved'
        AND accepted.id=(SELECT id FROM approvals WHERE gate='staging-acceptance'
          AND publish_job_id=promotion.staging_job_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
    ))
)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RETRY_MISMATCH'); END;

DROP TRIGGER publication_promotion_binding;
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
    AND a.candidate_checksum=j.candidate_checksum
    AND ((a.production_base_sha=j.base_sha AND NOT EXISTS (
      SELECT 1 FROM publication_retries WHERE job_id=j.id)) OR EXISTS (
      SELECT 1 FROM publication_retries lineage JOIN publication_promotions parent ON parent.job_id=lineage.parent_job_id
      WHERE lineage.job_id=j.id AND parent.approval_id=NEW.approval_id
        AND parent.staging_job_id=NEW.staging_job_id AND parent.artifact_digest=NEW.artifact_digest
    ))
    AND a.staging_commit_sha=staging.result_sha
    AND json_extract(a.candidate_json,'$.publicationProtocol')=2
    AND json_extract(a.candidate_json,'$.workflowRevision')=pi.workflow_revision
    AND json_extract(a.candidate_json,'$.artifactDigest')=NEW.artifact_digest
    AND a.id=(SELECT id FROM approvals WHERE gate='staging-acceptance' AND publish_job_id=staging.id
      ORDER BY created_at DESC,rowid DESC LIMIT 1)
)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_PROMOTION_MISMATCH'); END;
