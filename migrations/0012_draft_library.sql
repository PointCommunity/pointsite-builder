CREATE TABLE draft_library_items (
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  item_json TEXT NOT NULL CHECK(json_valid(item_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  PRIMARY KEY(draft_id,item_id)
);
CREATE TABLE draft_library_operations (
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  PRIMARY KEY(draft_id,actor,idempotency_key)
);
CREATE TABLE draft_library_asset_versions (
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES draft_asset_versions(id) ON DELETE CASCADE,
  PRIMARY KEY(draft_id,item_id,asset_id)
);
