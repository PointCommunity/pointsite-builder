/* Status lineage is separate from immutable revision sequence and source provenance. */
CREATE TABLE draft_publication_baselines (
  draft_id TEXT PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
  source_target TEXT NOT NULL CHECK(source_target IN ('staging','production','unknown')),
  baseline_release_id TEXT,
  baseline_sequence INTEGER NOT NULL DEFAULT 1 CHECK(baseline_sequence>=1)
);

/* Only exact, currently recorded Production identity proves old import lineage. */
INSERT INTO draft_publication_baselines(draft_id,source_target,baseline_release_id,baseline_sequence)
SELECT s.draft_id,COALESCE(json_extract(s.provenance_json,'$.target'),'production'),
  CASE WHEN COALESCE(json_extract(s.provenance_json,'$.target'),'production')='production'
    AND p.artifact_digest=json_extract(s.provenance_json,'$.artifactDigest')
    AND COALESCE(json_extract(p.source_json,'$.commitSha'),json_extract(p.source_json,'$.sourceRevision'))=
      json_extract(s.provenance_json,'$.sourceCommit')
    AND json_extract(p.evidence_json,'$.deploymentId')=json_extract(s.provenance_json,'$.deploymentId')
    THEN p.id ELSE NULL END,1
FROM draft_production_sources s
LEFT JOIN publication_releases p ON p.id=(SELECT id FROM publication_releases ORDER BY sequence DESC LIMIT 1);

/* Only durable verified Production release insertion resets the captured revision's count. */
CREATE TRIGGER draft_baseline_verified_release AFTER INSERT ON publication_releases
WHEN NEW.kind='publication'
BEGIN
  INSERT INTO draft_publication_baselines(draft_id,source_target,baseline_release_id,baseline_sequence)
  SELECT pi.draft_id,COALESCE(b.source_target,'unknown'),NEW.id,r.sequence
  FROM publication_inputs pi JOIN revisions r ON r.id=pi.revision_id AND r.draft_id=pi.draft_id
  LEFT JOIN draft_publication_baselines b ON b.draft_id=pi.draft_id
  WHERE pi.job_id=NEW.job_id
  ON CONFLICT(draft_id) DO UPDATE SET
    baseline_release_id=excluded.baseline_release_id,
    baseline_sequence=excluded.baseline_sequence;
END;
