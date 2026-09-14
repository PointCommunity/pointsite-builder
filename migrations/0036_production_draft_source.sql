CREATE TABLE draft_production_sources (
  draft_id TEXT PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json))
);
CREATE TRIGGER draft_production_sources_immutable
BEFORE UPDATE ON draft_production_sources
BEGIN SELECT RAISE(ABORT, 'production source is immutable'); END;
CREATE TRIGGER draft_production_sources_retained
BEFORE DELETE ON draft_production_sources
WHEN EXISTS (SELECT 1 FROM drafts WHERE id=OLD.draft_id AND status!='deleted')
BEGIN SELECT RAISE(ABORT, 'production source is retained with its draft'); END;
