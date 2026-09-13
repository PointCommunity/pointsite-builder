/* Existing application versions continue writing the original hash contract. */
ALTER TABLE idempotency_keys ADD COLUMN request_version INTEGER NOT NULL DEFAULT 1
  CHECK (request_version IN (1, 2));
