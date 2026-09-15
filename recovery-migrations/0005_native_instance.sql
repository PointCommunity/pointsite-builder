CREATE TABLE builder_instance (
  id INTEGER PRIMARY KEY CHECK (id=1),
  origin TEXT NOT NULL,
  instance_id TEXT NOT NULL CHECK (length(instance_id)=36)
);
CREATE TRIGGER builder_instance_identity BEFORE UPDATE ON builder_instance
BEGIN SELECT RAISE(ABORT,'BUILDER_INSTANCE_IMMUTABLE'); END;
CREATE TRIGGER builder_instance_retained BEFORE DELETE ON builder_instance
BEGIN SELECT RAISE(ABORT,'BUILDER_INSTANCE_RETAINED'); END;
