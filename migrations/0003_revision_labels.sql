CREATE TABLE revision_labels (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX revision_labels_revision_created
  ON revision_labels(revision_id, created_at DESC, id DESC);

CREATE TRIGGER revision_labels_are_immutable
BEFORE UPDATE ON revision_labels
BEGIN
  SELECT RAISE(ABORT, 'revision labels are immutable');
END;
