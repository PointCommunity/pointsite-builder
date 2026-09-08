ALTER TABLE revisions ADD COLUMN action_category TEXT
  CHECK (action_category IS NULL OR action_category IN (
    'text-edit','control-change','add','remove','duplicate','reorder','move','resize','replace','undo','redo','restore'
  ));

ALTER TABLE revisions ADD COLUMN action_context TEXT
  CHECK (action_context IS NULL OR action_context IN (
    'page-content','page-details','page-structure','forms','library-attachment','linked-media','navigation','theme','site-settings','collections','section-settings','element-settings','element-layout','revision-history','draft'
  ));

DROP TRIGGER IF EXISTS revisions_are_immutable;

CREATE TRIGGER revisions_are_immutable
BEFORE UPDATE OF draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at,action_category,action_context ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions are immutable');
END;
