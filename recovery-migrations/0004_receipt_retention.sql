CREATE INDEX deletion_receipts_resolved ON deletion_receipts(resolved_at,id)
  WHERE state!='pending';
