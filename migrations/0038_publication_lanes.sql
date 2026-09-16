/* Keep historical Production records unchanged; bind new lineage to its public destination. */
CREATE INDEX publication_releases_repository ON publication_releases(COALESCE(json_extract(source_json,'$.repository'),'PointCommunity/pointsite'),sequence);
CREATE VIEW current_publication_releases AS
SELECT * FROM publication_releases WHERE COALESCE(json_extract(source_json,'$.repository'),'PointCommunity/pointsite') =
  CASE WHEN (SELECT origin FROM builder_instance WHERE id=1)='https://builder-canary.eaglepass.io'
  THEN 'PointCommunity/pointsite-canary' ELSE 'PointCommunity/pointsite' END;

DROP TRIGGER publication_release_binding;
/* Historical, independently deployed Canary bootstrap. This records file verification over HTTP,
   not TLS readiness or an Administrator-authorized content publication. The original Production
   capture and its evidence remain untouched. Runtime publication always requires HTTPS proof. */
INSERT INTO publication_releases(id,kind,artifact_digest,source_json,evidence_json,verified_at)
VALUES ('public-canary-baseline-2026-09-16','baseline',
  '45562c9e111136f631c901892d2f1058e45050e93fa8d507f5beb0858eb68894',
  '{"repository":"PointCommunity/pointsite-canary","sourceRevision":"0187c95c8a9d3441049616a801f66f6f6d11050e","archiveRevision":"1161eb9eceaa40b1b66b841c705cbaedcd0c4b2c","archivePath":"publication-baseline/site.tar.gz","archiveBlobSha":"7ab59cb20fd90f7d193ae7fc165bc7ebbcba94b3","archiveSha256":"127a452216dde00aff67242db127cd1ec6c8807dce4e023a5b23f51365e41322","archiveBytes":1868591,"manifestPath":"publication-baseline/manifest.json","manifestBlobSha":"6a95478ed6aee9ab500b40f8d7689b6343776630","fileCount":97,"totalBytes":2792441}',
  '{"kind":"captured-public-site","deploymentId":"6484225086","nativeJobUrl":"https://github.com/PointCommunity/pointsite-canary/actions/runs/35114402268/job/104856028082","capturedAt":"2026-09-16T15:28:27Z","verifiedPasses":1,"transport":"http","tlsVerified":false}',
  '2026-09-16T15:28:27Z');
CREATE TRIGGER publication_release_binding BEFORE INSERT ON publication_releases
WHEN NEW.kind!='rollback' AND (NEW.kind!='publication' OR NOT EXISTS (
  SELECT 1 FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id
  JOIN publication_runs pr ON pr.job_id=j.id
  WHERE j.id=NEW.id AND j.id=NEW.job_id AND j.environment='production-merge' AND j.status='succeeded'
    AND pr.deploy_authorized_at IS NOT NULL AND pr.deployment_json IS NOT NULL
    AND NEW.previous_release_id IS (SELECT id FROM publication_releases WHERE COALESCE(json_extract(source_json,'$.repository'),'PointCommunity/pointsite')=COALESCE(json_extract(NEW.source_json,'$.repository'),'PointCommunity/pointsite') ORDER BY sequence DESC LIMIT 1)
    AND NEW.verified_at=j.completed_at AND NEW.evidence_json=j.evidence_json
    AND json_extract(j.evidence_json,'$.format')=2 AND json_extract(j.evidence_json,'$.verificationStatus')='passed'
    AND NEW.artifact_digest=json_extract(pr.build_json,'$.artifactDigest')
    AND NEW.artifact_digest=json_extract(pr.deployment_json,'$.artifactDigest')
    AND NEW.artifact_digest=json_extract(j.evidence_json,'$.artifactDigest')
    AND j.result_sha=json_extract(pr.build_json,'$.commitSha')
    AND j.result_sha=json_extract(j.evidence_json,'$.commitSha')
    AND j.candidate_checksum=json_extract(j.evidence_json,'$.candidateChecksum')
    AND pi.workflow_revision=json_extract(j.evidence_json,'$.workflowRevision')
    AND pr.run_id=json_extract(j.evidence_json,'$.runId')
    AND pr.check_run_id=json_extract(j.evidence_json,'$.checkRunId')
    AND pr.dispatch_revision=json_extract(j.evidence_json,'$.dispatchRevision')
    AND json_extract(NEW.source_json,'$.repository')=j.repository
    AND json_extract(NEW.source_json,'$.commitSha')=j.result_sha
    AND json_extract(NEW.source_json,'$.treeSha')=json_extract(pr.build_json,'$.treeSha')
    AND json_extract(NEW.source_json,'$.manifestBlobSha')=json_extract(pr.build_json,'$.manifestBlobSha')
    AND json_extract(NEW.source_json,'$.workflowRevision')=pi.workflow_revision
    AND json_extract(NEW.source_json,'$.candidateChecksum')=j.candidate_checksum
    AND json_extract(NEW.source_json,'$.fileCount')=json_extract(pr.build_json,'$.fileCount')
    AND json_extract(NEW.source_json,'$.totalBytes')=json_extract(pr.build_json,'$.totalBytes')
))
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RELEASE_MISMATCH'); END;

DROP TRIGGER publication_rollback_capture;
CREATE TRIGGER publication_rollback_capture BEFORE INSERT ON publication_rollbacks
WHEN COALESCE(json_extract(NEW.source_json,'$.repository'),'PointCommunity/pointsite') NOT IN ('PointCommunity/pointsite','PointCommunity/pointsite-canary')
  OR NOT EXISTS(SELECT 1 FROM publication_releases WHERE id=NEW.source_release_id AND COALESCE(json_extract(source_json,'$.repository'),'PointCommunity/pointsite')=COALESCE(json_extract(NEW.source_json,'$.repository'),'PointCommunity/pointsite'))
  OR EXISTS(SELECT 1 FROM publication_slots WHERE target='production')
  OR EXISTS(SELECT 1 FROM publish_jobs WHERE environment='production-merge' AND status IN ('queued','running'))
  OR EXISTS(SELECT 1 FROM publication_tombstones WHERE idempotency_key=NEW.idempotency_key)
  OR NOT EXISTS(SELECT 1 FROM user_roles WHERE email=NEW.requested_by AND active=1 AND role='administrator')
  OR NEW.previous_release_id IS NOT (SELECT id FROM publication_releases WHERE COALESCE(json_extract(source_json,'$.repository'),'PointCommunity/pointsite')=COALESCE(json_extract(NEW.source_json,'$.repository'),'PointCommunity/pointsite') ORDER BY sequence DESC LIMIT 1)
BEGIN SELECT RAISE(ABORT,'ROLLBACK_CAPTURE_CHANGED'); END;

DROP TRIGGER publication_rollback_release;
CREATE TRIGGER publication_rollback_release BEFORE INSERT ON publication_releases
WHEN NEW.kind='rollback' AND NOT EXISTS(
  SELECT 1 FROM publication_rollbacks r WHERE r.id=NEW.id AND NEW.job_id=r.id AND r.status='succeeded'
    AND r.deploy_authorized_at IS NOT NULL AND r.reported_at IS NOT NULL
    AND NEW.previous_release_id=r.previous_release_id
    AND NEW.previous_release_id IS (SELECT id FROM publication_releases WHERE COALESCE(json_extract(source_json,'$.repository'),'PointCommunity/pointsite')=COALESCE(json_extract(NEW.source_json,'$.repository'),'PointCommunity/pointsite') ORDER BY sequence DESC LIMIT 1)
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

DROP TRIGGER publication_release_retained;
CREATE TRIGGER publication_release_retained BEFORE DELETE ON publication_releases
WHEN OLD.sequence IN (SELECT sequence FROM publication_releases p WHERE p.sequence IN
    (SELECT sequence FROM publication_releases WHERE COALESCE(json_extract(source_json,'$.repository'),'PointCommunity/pointsite')=COALESCE(json_extract(p.source_json,'$.repository'),'PointCommunity/pointsite') ORDER BY sequence DESC LIMIT 2))
  OR OLD.recorded_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RELEASE_RETAINED'); END;

DROP TRIGGER publication_release_inputs_retained;
CREATE TRIGGER publication_release_inputs_retained BEFORE DELETE ON publication_inputs
WHEN OLD.job_id IN (SELECT job_id FROM publication_releases p WHERE p.sequence IN
    (SELECT sequence FROM publication_releases WHERE COALESCE(json_extract(source_json,'$.repository'),'PointCommunity/pointsite')=COALESCE(json_extract(p.source_json,'$.repository'),'PointCommunity/pointsite') ORDER BY sequence DESC LIMIT 2))
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RELEASE_INPUTS_RETAINED'); END;

DROP TRIGGER publication_release_assets_retained;
CREATE TRIGGER publication_release_assets_retained BEFORE DELETE ON publication_asset_pins
WHEN OLD.job_id IN (SELECT job_id FROM publication_releases p WHERE p.sequence IN
    (SELECT sequence FROM publication_releases WHERE COALESCE(json_extract(source_json,'$.repository'),'PointCommunity/pointsite')=COALESCE(json_extract(p.source_json,'$.repository'),'PointCommunity/pointsite') ORDER BY sequence DESC LIMIT 2))
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RELEASE_INPUTS_RETAINED'); END;

DROP TRIGGER publication_rollback_retained;
CREATE TRIGGER publication_rollback_retained BEFORE DELETE ON publication_rollbacks
WHEN OLD.status IN ('queued','running') OR OLD.completed_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')
  OR OLD.id IN (SELECT job_id FROM publication_releases p WHERE p.sequence IN
    (SELECT sequence FROM publication_releases WHERE COALESCE(json_extract(source_json,'$.repository'),'PointCommunity/pointsite')=COALESCE(json_extract(p.source_json,'$.repository'),'PointCommunity/pointsite') ORDER BY sequence DESC LIMIT 2))
BEGIN SELECT RAISE(ABORT,'ROLLBACK_RETAINED'); END;
