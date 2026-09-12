CREATE TABLE draft_asset_migration (
  id INTEGER PRIMARY KEY CHECK(id=1),
  state TEXT NOT NULL CHECK(state IN ('pending','complete')),
  recovery_draft_id TEXT,
  completed_at TEXT
);
INSERT INTO draft_asset_migration(id,state)
SELECT 1,CASE WHEN EXISTS(SELECT 1 FROM media_assets) OR EXISTS(SELECT 1 FROM media_object_chunks) OR EXISTS(
  SELECT 1 FROM revisions r,json_each(r.document_json,'$.media') item
  WHERE NOT EXISTS(SELECT 1 FROM draft_asset_bindings b WHERE b.draft_id=r.draft_id
    AND b.source_path=json_extract(item.value,'$.sourcePath'))
) THEN 'pending' ELSE 'complete' END;

CREATE TABLE draft_asset_migration_verified (
  draft_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES draft_asset_versions(id) ON DELETE CASCADE,
  checksum TEXT NOT NULL,
  PRIMARY KEY(draft_id,source_path)
);
CREATE TABLE draft_asset_migration_recovered (
  legacy_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES draft_asset_versions(id) ON DELETE CASCADE
);

CREATE TRIGGER legacy_media_no_insert BEFORE INSERT ON media_assets
BEGIN SELECT RAISE(ABORT,'global media storage retired'); END;
CREATE TRIGGER legacy_media_no_update BEFORE UPDATE ON media_assets
BEGIN SELECT RAISE(ABORT,'global media storage retired'); END;
CREATE TRIGGER legacy_chunks_no_insert BEFORE INSERT ON media_object_chunks
BEGIN SELECT RAISE(ABORT,'global media storage retired'); END;
CREATE TRIGGER legacy_chunks_no_update BEFORE UPDATE ON media_object_chunks
BEGIN SELECT RAISE(ABORT,'global media storage retired'); END;
CREATE TRIGGER legacy_media_delete_guard BEFORE DELETE ON media_assets
WHEN (SELECT state FROM draft_asset_migration WHERE id=1)!='complete'
BEGIN SELECT RAISE(ABORT,'draft asset migration incomplete'); END;
CREATE TRIGGER legacy_chunks_delete_guard BEFORE DELETE ON media_object_chunks
WHEN (SELECT state FROM draft_asset_migration WHERE id=1)!='complete'
BEGIN SELECT RAISE(ABORT,'draft asset migration incomplete'); END;
CREATE TRIGGER draft_purge_migration_guard BEFORE UPDATE OF status ON drafts
WHEN NEW.status='deleted' AND (SELECT state FROM draft_asset_migration WHERE id=1)!='complete'
BEGIN SELECT RAISE(ABORT,'draft asset migration incomplete'); END;
CREATE TRIGGER draft_delete_migration_guard BEFORE DELETE ON drafts
WHEN (SELECT state FROM draft_asset_migration WHERE id=1)!='complete'
BEGIN SELECT RAISE(ABORT,'draft asset migration incomplete'); END;

DROP TRIGGER audit_events_are_immutable;
CREATE TRIGGER audit_events_are_immutable BEFORE UPDATE ON audit_events
WHEN NOT (
  NEW.metadata_json='{}' AND OLD.target_type='media'
  AND (SELECT state FROM draft_asset_migration WHERE id=1)='complete'
  AND EXISTS(SELECT 1 FROM media_assets WHERE id=OLD.target_id)
  AND NEW.id=OLD.id AND NEW.occurred_at=OLD.occurred_at AND NEW.actor=OLD.actor
  AND NEW.action=OLD.action AND NEW.target_type=OLD.target_type AND NEW.target_id=OLD.target_id
  AND NEW.outcome=OLD.outcome AND NEW.request_id=OLD.request_id AND NEW.ip_hash IS OLD.ip_hash
)
BEGIN SELECT RAISE(ABORT,'audit events are immutable'); END;
