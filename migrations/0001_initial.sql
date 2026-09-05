PRAGMA foreign_keys = ON;

CREATE TABLE user_roles (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'publisher', 'administrator')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL DEFAULT 'pointsite' CHECK (site_id = 'pointsite'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  latest_revision_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK ((status = 'deleted' AND deleted_at IS NOT NULL) OR (status != 'deleted' AND deleted_at IS NULL))
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  parent_revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^a-f0-9]*'),
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  label TEXT CHECK (label IS NULL OR length(label) <= 100),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  renderer_version TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (draft_id, sequence)
);

CREATE INDEX revisions_draft_sequence ON revisions(draft_id, sequence DESC);
CREATE INDEX drafts_status_updated ON drafts(status, updated_at DESC);

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 100),
  actor TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, idempotency_key, actor)
);

CREATE INDEX idempotency_expiry ON idempotency_keys(expires_at);

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8000),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8000),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  alt_text TEXT NOT NULL CHECK (length(alt_text) BETWEEN 1 AND 300),
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'rejected', 'published', 'orphaned')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_referenced_at TEXT,
  UNIQUE (checksum, byte_size)
);

CREATE INDEX media_status_reference ON media_assets(status, last_referenced_at);

CREATE TABLE publish_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 100),
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production-pr', 'production-merge', 'rollback')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json)),
  candidate_checksum TEXT NOT NULL CHECK (length(candidate_checksum) = 64),
  repository TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  result_sha TEXT,
  external_url TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX one_running_publish_per_environment
  ON publish_jobs(environment)
  WHERE status = 'running';
CREATE INDEX publish_jobs_status_requested ON publish_jobs(status, requested_at DESC);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  gate TEXT NOT NULL CHECK (gate IN ('staging-acceptance', 'production-preparation', 'production-publication')),
  candidate_checksum TEXT NOT NULL CHECK (length(candidate_checksum) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'revoked')),
  actor TEXT NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at TEXT NOT NULL
);

CREATE INDEX approvals_candidate_gate ON approvals(candidate_checksum, gate, created_at DESC);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'denied')),
  request_id TEXT NOT NULL,
  ip_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
);

CREATE INDEX audit_occurred ON audit_events(occurred_at DESC, id DESC);
CREATE INDEX audit_actor_occurred ON audit_events(actor, occurred_at DESC);
