ALTER TABLE idempotency_keys ADD COLUMN response_version INTEGER NOT NULL DEFAULT 1 CHECK(response_version IN (1,2));
CREATE INDEX idempotency_retained_revision ON idempotency_keys(json_extract(response_json,'$.latestRevisionId'),expires_at);
CREATE TRIGGER compact_receipt_revision_guard BEFORE INSERT ON idempotency_keys
WHEN NEW.response_version=2 AND NOT EXISTS(
  SELECT 1 FROM revisions r WHERE r.id=json_extract(NEW.response_json,'$.latestRevisionId')
    AND r.id=json_extract(NEW.response_json,'$.revision.id')
    AND r.draft_id=json_extract(NEW.response_json,'$.id')
    AND r.checksum=json_extract(NEW.response_json,'$.revision.checksum')
)
BEGIN SELECT RAISE(ABORT,'invalid compact receipt revision'); END;
CREATE TRIGGER revision_receipt_retention_guard BEFORE DELETE ON revisions
WHEN NOT EXISTS(SELECT 1 FROM drafts WHERE id=OLD.draft_id AND status='deleted')
  AND EXISTS(SELECT 1 FROM idempotency_keys k
    WHERE json_extract(k.response_json,'$.latestRevisionId')=OLD.id
      AND k.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'revision retained by request receipt'); END;
CREATE INDEX idempotency_legacy_payload ON idempotency_keys(created_at,scope,actor,idempotency_key)
WHERE response_version=1 AND status_code IN (200,201) AND json_type(response_json,'$.document')='object';
CREATE TRIGGER compact_receipt_update_guard BEFORE UPDATE OF response_version,response_json ON idempotency_keys
WHEN NEW.response_version=2 AND NEW.status_code IN (200,201)
  AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NOT EXISTS(
    SELECT 1 FROM revisions r WHERE r.id=json_extract(NEW.response_json,'$.latestRevisionId')
      AND r.id=json_extract(NEW.response_json,'$.revision.id')
      AND r.draft_id=json_extract(NEW.response_json,'$.id')
      AND r.checksum=json_extract(NEW.response_json,'$.revision.checksum')
  )
BEGIN SELECT RAISE(ABORT,'invalid compact receipt revision'); END;
