CREATE TABLE draft_checkouts (
  draft_id TEXT PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
  actor TEXT NOT NULL COLLATE NOCASE,
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 16 AND 100),
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  acquired_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX draft_checkouts_actor_expiry ON draft_checkouts(actor, expires_at);
CREATE INDEX draft_checkouts_expiry ON draft_checkouts(expires_at);

CREATE TABLE editor_view_states (
  actor TEXT PRIMARY KEY COLLATE NOCASE,
  draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  panel TEXT NOT NULL CHECK (panel IN ('layout','forms','library','preview','history','settings','admin')),
  page_id TEXT,
  selected_element_id TEXT,
  preview_viewport TEXT NOT NULL CHECK (preview_viewport IN ('phone','tablet','desktop')),
  preview_zoom REAL NOT NULL CHECK (preview_zoom BETWEEN 0.25 AND 2),
  scroll_positions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scroll_positions_json) AND length(scroll_positions_json) <= 1024),
  updated_at TEXT NOT NULL
);
