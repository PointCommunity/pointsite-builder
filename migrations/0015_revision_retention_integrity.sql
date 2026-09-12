DROP TRIGGER revisions_are_immutable;
CREATE TRIGGER revisions_are_immutable
BEFORE UPDATE OF draft_id,sequence,checksum,document_json,label,schema_version,renderer_version,created_by,created_at,action_category,action_context ON revisions
BEGIN SELECT RAISE(ABORT,'revisions are immutable'); END;
CREATE TRIGGER revision_parent_is_immutable BEFORE UPDATE OF parent_revision_id ON revisions
WHEN NEW.parent_revision_id IS NOT NULL
  OR EXISTS(SELECT 1 FROM revisions WHERE id=OLD.parent_revision_id)
BEGIN SELECT RAISE(ABORT,'revision parent is immutable'); END;
