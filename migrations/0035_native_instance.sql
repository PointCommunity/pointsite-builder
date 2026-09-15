CREATE TABLE builder_instance (
  id INTEGER PRIMARY KEY CHECK (id=1),
  origin TEXT NOT NULL,
  instance_id TEXT NOT NULL CHECK (length(instance_id)=36),
  bootstrapped INTEGER NOT NULL DEFAULT 0 CHECK (bootstrapped IN (0,1))
);
CREATE TRIGGER builder_instance_identity BEFORE UPDATE OF origin,instance_id ON builder_instance
BEGIN SELECT RAISE(ABORT,'BUILDER_INSTANCE_IMMUTABLE'); END;
CREATE TRIGGER builder_instance_retained BEFORE DELETE ON builder_instance
BEGIN SELECT RAISE(ABORT,'BUILDER_INSTANCE_RETAINED'); END;
CREATE TRIGGER builder_bootstrap_once BEFORE UPDATE OF bootstrapped ON builder_instance
WHEN OLD.bootstrapped=1 AND NEW.bootstrapped!=1
BEGIN SELECT RAISE(ABORT,'BUILDER_BOOTSTRAP_ALREADY_COMPLETE'); END;
