CREATE TABLE draft_asset_versions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','image/avif')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8000),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8000),
  checksum TEXT NOT NULL CHECK (length(checksum)=64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (draft_id,id)
);
CREATE INDEX draft_asset_versions_owner ON draft_asset_versions(draft_id);

CREATE TABLE draft_asset_chunks (
  asset_id TEXT NOT NULL REFERENCES draft_asset_versions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index>=0),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 1000000),
  bytes BLOB NOT NULL CHECK (length(bytes)=byte_size),
  PRIMARY KEY (asset_id,chunk_index)
);

CREATE TABLE draft_asset_bindings (
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  PRIMARY KEY (draft_id,source_path),
  FOREIGN KEY (draft_id,asset_id) REFERENCES draft_asset_versions(draft_id,id) ON DELETE CASCADE
);

CREATE TRIGGER draft_asset_versions_immutable BEFORE UPDATE ON draft_asset_versions
BEGIN SELECT RAISE(ABORT,'draft assets are immutable'); END;
CREATE TRIGGER draft_asset_chunks_immutable BEFORE UPDATE ON draft_asset_chunks
BEGIN SELECT RAISE(ABORT,'draft asset bytes are immutable'); END;
CREATE TRIGGER draft_asset_bindings_immutable BEFORE UPDATE ON draft_asset_bindings
BEGIN SELECT RAISE(ABORT,'draft asset bindings are immutable'); END;

CREATE TRIGGER draft_asset_capacity BEFORE INSERT ON draft_asset_versions
WHEN NEW.byte_size + (SELECT COALESCE(SUM(byte_size),0) FROM draft_asset_versions)
  + (SELECT COALESCE(SUM(byte_size),0) FROM media_object_chunks) > 262144000
BEGIN SELECT RAISE(ABORT,'MEDIA_CAPACITY_EXCEEDED'); END;

CREATE TRIGGER draft_asset_chunk_size BEFORE INSERT ON draft_asset_chunks
WHEN NEW.byte_size + (SELECT COALESCE(SUM(byte_size),0) FROM draft_asset_chunks WHERE asset_id=NEW.asset_id)
  > (SELECT byte_size FROM draft_asset_versions WHERE id=NEW.asset_id)
BEGIN SELECT RAISE(ABORT,'MEDIA_STORAGE_CORRUPT'); END;
