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
BEFORE UPDATE ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions are immutable');
END;

CREATE TRIGGER approvals_are_immutable
BEFORE UPDATE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are immutable');
END;

CREATE TRIGGER audit_events_are_immutable
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;
