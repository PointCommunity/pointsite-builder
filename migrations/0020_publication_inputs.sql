CREATE TABLE publication_inputs (
  job_id TEXT PRIMARY KEY REFERENCES publish_jobs(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
  workflow_revision TEXT NOT NULL CHECK(length(workflow_revision)=40 AND workflow_revision NOT GLOB '*[^a-f0-9]*'),
  UNIQUE(job_id,draft_id)
);
CREATE INDEX publication_inputs_revision ON publication_inputs(revision_id);
CREATE INDEX publication_inputs_draft ON publication_inputs(draft_id);
CREATE TRIGGER publication_inputs_owner BEFORE INSERT ON publication_inputs
WHEN NOT EXISTS (
  SELECT 1 FROM revisions r JOIN publish_jobs j ON j.id=NEW.job_id
  WHERE r.id=NEW.revision_id AND r.draft_id=NEW.draft_id
    AND json_extract(j.candidate_json,'$.draftId')=NEW.draft_id
    AND json_extract(j.candidate_json,'$.revisionId')=NEW.revision_id
    AND json_extract(j.candidate_json,'$.revisionChecksum')=r.checksum
    AND json_extract(j.candidate_json,'$.workflowRevision')=NEW.workflow_revision
    AND json_extract(j.candidate_json,'$.publicationProtocol')=2
)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_INPUT_MISMATCH'); END;
CREATE TRIGGER publication_inputs_immutable BEFORE UPDATE ON publication_inputs
BEGIN SELECT RAISE(ABORT,'PUBLICATION_INPUT_IMMUTABLE'); END;

CREATE TABLE publication_asset_pins (
  job_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  PRIMARY KEY(job_id,source_path),
  FOREIGN KEY(job_id,draft_id) REFERENCES publication_inputs(job_id,draft_id) ON DELETE CASCADE,
  FOREIGN KEY(draft_id,asset_id) REFERENCES draft_asset_versions(draft_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(draft_id,source_path) REFERENCES draft_asset_bindings(draft_id,source_path) ON DELETE RESTRICT
);
CREATE INDEX publication_asset_pins_asset ON publication_asset_pins(draft_id,asset_id);
CREATE INDEX publication_asset_pins_path ON publication_asset_pins(draft_id,source_path);
CREATE TRIGGER publication_asset_pin_binding BEFORE INSERT ON publication_asset_pins
WHEN NOT EXISTS (
  SELECT 1 FROM draft_asset_bindings b WHERE b.draft_id=NEW.draft_id
    AND b.source_path=NEW.source_path AND b.asset_id=NEW.asset_id
)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_ASSET_MISMATCH'); END;
CREATE TRIGGER publication_asset_pin_immutable BEFORE UPDATE ON publication_asset_pins
BEGIN SELECT RAISE(ABORT,'PUBLICATION_INPUT_IMMUTABLE'); END;

CREATE TRIGGER publication_job_input_immutable BEFORE UPDATE OF candidate_json,candidate_checksum,base_sha,repository,environment,requested_by ON publish_jobs
WHEN EXISTS (SELECT 1 FROM publication_inputs WHERE job_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_INPUT_IMMUTABLE'); END;
CREATE TRIGGER publication_asset_chunk_delete BEFORE DELETE ON draft_asset_chunks
WHEN EXISTS (SELECT 1 FROM publication_asset_pins WHERE asset_id=OLD.asset_id)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_INPUT_IMMUTABLE'); END;
CREATE TRIGGER publication_asset_chunk_insert BEFORE INSERT ON draft_asset_chunks
WHEN EXISTS (SELECT 1 FROM publication_asset_pins WHERE asset_id=NEW.asset_id)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_INPUT_IMMUTABLE'); END;
CREATE INDEX publication_asset_pins_chunk ON publication_asset_pins(asset_id);

/* A slot remains held through Stage review. Time alone must never let a second
   runner overwrite a deployment that is still finishing at the provider. */
CREATE TABLE publication_slots (
  target TEXT PRIMARY KEY CHECK(target IN ('staging','production')),
  job_id TEXT NOT NULL UNIQUE REFERENCES publication_inputs(job_id) ON DELETE RESTRICT
);
CREATE TRIGGER publication_slot_exclusive BEFORE INSERT ON publish_jobs
WHEN EXISTS (SELECT 1 FROM publication_slots WHERE
  (target='staging' AND NEW.environment='staging') OR
  (target='production' AND NEW.environment='production-merge'))
BEGIN SELECT RAISE(ABORT,'PUBLISH_SLOT_BUSY'); END;
CREATE TABLE publication_runs (
  job_id TEXT PRIMARY KEY REFERENCES publication_inputs(job_id) ON DELETE CASCADE,
  nonce TEXT NOT NULL CHECK(length(nonce)=64 AND nonce NOT GLOB '*[^a-f0-9]*'),
  dispatch_revision TEXT NOT NULL CHECK(length(dispatch_revision)=40 AND dispatch_revision NOT GLOB '*[^a-f0-9]*'),
  run_id TEXT,
  run_attempt TEXT,
  check_run_id TEXT,
  claimed_at TEXT,
  dispatch_after TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_count>=0),
  CHECK((run_id IS NULL AND run_attempt IS NULL AND check_run_id IS NULL AND claimed_at IS NULL)
    OR (run_id IS NOT NULL AND run_attempt IS NOT NULL AND check_run_id IS NOT NULL AND claimed_at IS NOT NULL))
);
CREATE TRIGGER publication_run_scope_immutable BEFORE UPDATE OF job_id,nonce,dispatch_revision ON publication_runs
BEGIN SELECT RAISE(ABORT,'PUBLICATION_INPUT_IMMUTABLE'); END;
CREATE TRIGGER publication_run_claim_immutable BEFORE UPDATE OF run_id,run_attempt,check_run_id,claimed_at ON publication_runs
WHEN OLD.run_id IS NOT NULL AND (NEW.run_id IS NOT OLD.run_id OR NEW.run_attempt IS NOT OLD.run_attempt
  OR NEW.check_run_id IS NOT OLD.check_run_id OR NEW.claimed_at IS NOT OLD.claimed_at)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RUN_ALREADY_CLAIMED'); END;
