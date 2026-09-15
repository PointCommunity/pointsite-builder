CREATE TABLE deletion_receipts (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  target_json TEXT NOT NULL CHECK(json_valid(target_json) AND length(target_json)<=20000),
  target_hash TEXT NOT NULL CHECK(length(target_hash)=64),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','committed','cancelled')),
  prepared_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  CHECK((state='pending' AND resolved_at IS NULL) OR (state!='pending' AND resolved_at IS NOT NULL))
);
CREATE INDEX deletion_receipts_pending ON deletion_receipts(state,prepared_at,id);
CREATE TRIGGER deletion_receipt_immutable BEFORE UPDATE ON deletion_receipts
WHEN NEW.id!=OLD.id OR NEW.target_json!=OLD.target_json OR NEW.target_hash!=OLD.target_hash
  OR NEW.prepared_at!=OLD.prepared_at OR OLD.state!='pending'
BEGIN SELECT RAISE(ABORT,'DELETION_RECEIPT_IMMUTABLE'); END;
