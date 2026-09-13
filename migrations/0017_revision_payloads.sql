/* Compact writes remain disabled until a compatible reader deployment is verified. */
CREATE TABLE revision_payloads (
  revision_id TEXT PRIMARY KEY REFERENCES revisions(id) ON DELETE CASCADE,
  base_revision_id TEXT REFERENCES revision_payloads(revision_id) ON DELETE RESTRICT,
  codec TEXT NOT NULL CHECK(codec IN ('gzip','gzip-splice')),
  payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload) BETWEEN 1 AND 1501024),
  raw_bytes INTEGER NOT NULL CHECK(raw_bytes BETWEEN 1 AND 1500000),
  prefix_bytes INTEGER NOT NULL CHECK(prefix_bytes>=0),
  suffix_bytes INTEGER NOT NULL CHECK(suffix_bytes>=0),
  CHECK(prefix_bytes+suffix_bytes<=raw_bytes),
  CHECK((codec='gzip' AND base_revision_id IS NULL AND prefix_bytes=0 AND suffix_bytes=0)
    OR (codec='gzip-splice' AND base_revision_id IS NOT NULL))
);
CREATE INDEX revision_payloads_base ON revision_payloads(base_revision_id);
CREATE TRIGGER revision_payloads_are_immutable BEFORE UPDATE ON revision_payloads
BEGIN SELECT RAISE(ABORT,'revision payloads are immutable'); END;
CREATE TRIGGER revision_payload_base_guard BEFORE INSERT ON revision_payloads
WHEN NEW.base_revision_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM revision_payloads p JOIN revisions b ON b.id=p.revision_id
  JOIN revisions r ON r.id=NEW.revision_id
  WHERE p.revision_id=NEW.base_revision_id AND p.codec='gzip' AND b.draft_id=r.draft_id
    AND r.sequence>b.sequence AND r.sequence-b.sequence<32
    AND NEW.prefix_bytes+NEW.suffix_bytes<=p.raw_bytes
)
BEGIN SELECT RAISE(ABORT,'invalid revision checkpoint'); END;
CREATE TRIGGER revision_payload_migration_guard BEFORE INSERT ON revision_payloads
WHEN (SELECT state FROM draft_asset_migration WHERE id=1) IS NOT 'complete'
BEGIN SELECT RAISE(ABORT,'draft asset migration incomplete'); END;
CREATE TRIGGER compact_latest_revision_guard BEFORE UPDATE OF latest_revision_id ON drafts
WHEN NEW.latest_revision_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM revisions r WHERE r.id=NEW.latest_revision_id AND r.document_json='{}'
    AND NOT EXISTS(SELECT 1 FROM revision_payloads p WHERE p.revision_id=r.id)
)
BEGIN SELECT RAISE(ABORT,'compact revision payload missing'); END;
CREATE INDEX revisions_legacy_payload ON revisions(draft_id,sequence) WHERE document_json!='{}';
DROP TRIGGER revisions_are_immutable;
CREATE TRIGGER revisions_are_immutable
BEFORE UPDATE OF draft_id,sequence,checksum,document_json,label,schema_version,renderer_version,created_by,created_at,action_category,action_context ON revisions
WHEN NOT (
  OLD.document_json!='{}' AND NEW.document_json='{}'
  AND NEW.id IS OLD.id AND NEW.draft_id IS OLD.draft_id AND NEW.sequence IS OLD.sequence
  AND NEW.checksum IS OLD.checksum AND NEW.label IS OLD.label AND NEW.schema_version IS OLD.schema_version
  AND NEW.renderer_version IS OLD.renderer_version AND NEW.created_by IS OLD.created_by
  AND NEW.created_at IS OLD.created_at AND NEW.action_category IS OLD.action_category
  AND NEW.action_context IS OLD.action_context
  AND EXISTS(SELECT 1 FROM revision_payloads WHERE revision_id=OLD.id)
)
BEGIN SELECT RAISE(ABORT,'revisions are immutable'); END;
