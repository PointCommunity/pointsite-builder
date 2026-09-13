CREATE TABLE provider_usage (
  id INTEGER PRIMARY KEY CHECK(id=1),
  attempt_id TEXT,
  refresh_after TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  checked_at TEXT,
  collected_at TEXT,
  data_json TEXT CHECK(data_json IS NULL OR (json_valid(data_json) AND length(data_json)<=4096)),
  last_error TEXT CHECK(last_error IS NULL OR last_error='unavailable')
);
INSERT INTO provider_usage(id) VALUES (1);
