ALTER TABLE user_roles ADD COLUMN github_login TEXT COLLATE NOCASE;

CREATE UNIQUE INDEX user_roles_github_login
  ON user_roles(github_login)
  WHERE github_login IS NOT NULL;

CREATE TABLE media_object_chunks (
  object_key TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 1000000),
  bytes BLOB NOT NULL,
  PRIMARY KEY (object_key, chunk_index),
  CHECK (length(bytes) = byte_size)
);

CREATE INDEX media_object_chunks_key ON media_object_chunks(object_key, chunk_index);

CREATE TRIGGER media_capacity_before_insert
BEFORE INSERT ON media_assets
WHEN NEW.status != 'rejected'
  AND (SELECT COALESCE(SUM(byte_size), 0) FROM media_assets WHERE status != 'rejected')
      + NEW.byte_size > 262144000
BEGIN
  SELECT RAISE(ABORT, 'private media capacity exceeded');
END;

CREATE TRIGGER media_capacity_before_update
BEFORE UPDATE OF byte_size, status ON media_assets
WHEN NEW.status != 'rejected'
  AND (SELECT COALESCE(SUM(byte_size), 0) FROM media_assets
       WHERE status != 'rejected' AND id != OLD.id)
      + NEW.byte_size > 262144000
BEGIN
  SELECT RAISE(ABORT, 'private media capacity exceeded');
END;
