-- Manual rollback for an unlaunched or fully exported environment only.
-- D1 migrations are forward-only in normal operation. Back up data before use.
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS publish_jobs;
DROP TABLE IF EXISTS media_assets;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS revisions;
DROP TABLE IF EXISTS drafts;
DROP TABLE IF EXISTS user_roles;
