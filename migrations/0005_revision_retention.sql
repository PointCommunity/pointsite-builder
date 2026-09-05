PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS revision_labels_are_immutable;
DROP TRIGGER IF EXISTS revisions_are_immutable;
DROP TRIGGER IF EXISTS drafts_latest_revision_exists;

ALTER TABLE revisions RENAME TO revisions_legacy;
ALTER TABLE revision_labels RENAME TO revision_labels_legacy;

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  parent_revision_id TEXT REFERENCES revisions(id) ON DELETE SET NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  label TEXT CHECK (label IS NULL OR length(label) <= 100),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  renderer_version TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (draft_id, sequence)
);

INSERT INTO revisions
SELECT id,draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at
FROM revisions_legacy;

CREATE TABLE revision_labels (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO revision_labels SELECT * FROM revision_labels_legacy;

DROP TABLE revision_labels_legacy;
DROP TABLE revisions_legacy;

CREATE INDEX revisions_draft_sequence ON revisions(draft_id, sequence DESC);
CREATE INDEX revision_labels_revision_created ON revision_labels(revision_id, created_at DESC, id DESC);

CREATE TRIGGER drafts_latest_revision_exists
BEFORE UPDATE OF latest_revision_id ON drafts
WHEN NEW.latest_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM revisions
    WHERE id = NEW.latest_revision_id AND draft_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'latest revision must belong to draft');
END;

CREATE TRIGGER revisions_are_immutable
BEFORE UPDATE OF draft_id,sequence,checksum,document_json,label,schema_version,renderer_version,created_by,created_at ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions are immutable');
END;

CREATE TRIGGER revision_labels_are_immutable
BEFORE UPDATE ON revision_labels
BEGIN
  SELECT RAISE(ABORT, 'revision labels are immutable');
END;

PRAGMA foreign_keys = ON;
