ALTER TABLE media_assets ADD COLUMN display_name TEXT;
ALTER TABLE media_assets ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json));
