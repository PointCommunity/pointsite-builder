CREATE TABLE draft_library_projection (
  draft_id TEXT PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL DEFAULT 0,
  generation TEXT NOT NULL DEFAULT ''
);
CREATE TABLE draft_library_history (
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(draft_id,item_id)
);
CREATE TABLE draft_library_retained_paths (
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  PRIMARY KEY(draft_id,source_path)
);
CREATE TRIGGER library_projection_retention AFTER DELETE ON revisions
BEGIN
  INSERT INTO draft_library_projection(draft_id,sequence,generation)
    SELECT OLD.draft_id,0,lower(hex(randomblob(16))) WHERE EXISTS(SELECT 1 FROM drafts WHERE id=OLD.draft_id)
    ON CONFLICT(draft_id) DO UPDATE SET sequence=0,generation=excluded.generation;
  DELETE FROM draft_library_history WHERE draft_id=OLD.draft_id;
  DELETE FROM draft_library_retained_paths WHERE draft_id=OLD.draft_id;
END;
