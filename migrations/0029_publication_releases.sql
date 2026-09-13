CREATE TABLE publication_releases (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('baseline','publication')),
  /* Historical identifiers survive input retention; the latest two retain actual pins below. */
  job_id TEXT UNIQUE,
  previous_release_id TEXT,
  artifact_digest TEXT NOT NULL CHECK(length(artifact_digest)=64 AND artifact_digest NOT GLOB '*[^a-f0-9]*'),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  verified_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((kind='baseline' AND job_id IS NULL) OR (kind='publication' AND job_id=id))
);
CREATE INDEX publication_releases_age ON publication_releases(recorded_at,sequence);
CREATE UNIQUE INDEX publication_releases_deployment ON publication_releases(json_extract(evidence_json,'$.deploymentId'));

/* Historical public capture, not a declaration of the current live deployment.
   Source/archive checks and the captured file manifest are reviewed in PointSite PR #1. */
INSERT INTO publication_releases(id,kind,artifact_digest,source_json,evidence_json,verified_at)
VALUES ('public-baseline-2026-09-13','baseline',
  '45562c9e111136f631c901892d2f1058e45050e93fa8d507f5beb0858eb68894',
  '{"repository":"PointCommunity/pointsite","sourceRevision":"0187c95c8a9d3441049616a801f66f6f6d11050e","archiveRevision":"e860b80970067a9263a28fdd12bdcbdd57b110a5","archivePath":"publication-baseline/site.tar.gz","archiveBlobSha":"7ab59cb20fd90f7d193ae7fc165bc7ebbcba94b3","archiveSha256":"127a452216dde00aff67242db127cd1ec6c8807dce4e023a5b23f51365e41322","archiveBytes":1868591,"manifestPath":"publication-baseline/manifest.json","manifestBlobSha":"6a95478ed6aee9ab500b40f8d7689b6343776630","fileCount":97,"totalBytes":2792441}',
  '{"kind":"captured-public-site","deploymentId":"6276181817","nativeJobUrl":"https://github.com/PointCommunity/pointsite/actions/runs/33939223439/job/101233260612","capturedAt":"2026-09-13T08:26:55.584Z","verifiedPasses":2,"browserChecks":66}',
  '2026-09-13T08:26:55.584Z');

CREATE TRIGGER publication_release_binding BEFORE INSERT ON publication_releases
WHEN NEW.kind!='publication' OR NOT EXISTS (
  SELECT 1 FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id
  JOIN publication_runs pr ON pr.job_id=j.id
  WHERE j.id=NEW.id AND j.id=NEW.job_id AND j.environment='production-merge' AND j.status='succeeded'
    AND pr.deploy_authorized_at IS NOT NULL AND pr.deployment_json IS NOT NULL
    AND NEW.previous_release_id IS (SELECT id FROM publication_releases ORDER BY sequence DESC LIMIT 1)
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
)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RELEASE_MISMATCH'); END;
CREATE TRIGGER publication_release_immutable BEFORE UPDATE ON publication_releases
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RELEASE_IMMUTABLE'); END;
CREATE TRIGGER publication_release_retained BEFORE DELETE ON publication_releases
WHEN OLD.sequence IN (SELECT sequence FROM publication_releases ORDER BY sequence DESC LIMIT 2)
  OR OLD.recorded_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RELEASE_RETAINED'); END;
CREATE TRIGGER publication_release_inputs_retained BEFORE DELETE ON publication_inputs
WHEN OLD.job_id IN (SELECT job_id FROM publication_releases ORDER BY sequence DESC LIMIT 2)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RELEASE_INPUTS_RETAINED'); END;
CREATE TRIGGER publication_release_assets_retained BEFORE DELETE ON publication_asset_pins
WHEN OLD.job_id IN (SELECT job_id FROM publication_releases ORDER BY sequence DESC LIMIT 2)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RELEASE_INPUTS_RETAINED'); END;
