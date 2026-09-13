ALTER TABLE publication_runs ADD COLUMN build_json TEXT CHECK(build_json IS NULL OR json_valid(build_json));
ALTER TABLE publication_runs ADD COLUMN commit_authorized_at TEXT;
ALTER TABLE publication_runs ADD COLUMN deploy_authorized_at TEXT;
ALTER TABLE publication_runs ADD COLUMN deployment_json TEXT CHECK(deployment_json IS NULL OR json_valid(deployment_json));
ALTER TABLE publication_runs ADD COLUMN reserved_run_id TEXT;
ALTER TABLE publication_runs ADD COLUMN reserved_run_attempt TEXT;
ALTER TABLE publication_runs ADD COLUMN reserved_check_run_id TEXT CHECK(
  (reserved_run_id IS NULL AND reserved_run_attempt IS NULL AND reserved_check_run_id IS NULL) OR
  (reserved_run_id IS NOT NULL AND reserved_run_attempt IS NOT NULL AND reserved_check_run_id IS NOT NULL)
);

/* Reserve before entering a native deployment environment. Duplicate dispatches
   must not create deployment records that supersede the authorized run. */
CREATE TRIGGER publication_reservation_immutable BEFORE UPDATE OF reserved_run_id,reserved_run_attempt,reserved_check_run_id ON publication_runs
WHEN OLD.reserved_run_id IS NOT NULL AND (NEW.reserved_run_id IS NOT OLD.reserved_run_id
  OR NEW.reserved_run_attempt IS NOT OLD.reserved_run_attempt OR NEW.reserved_check_run_id IS NOT OLD.reserved_check_run_id)
BEGIN SELECT RAISE(ABORT,'PUBLICATION_RUN_ALREADY_RESERVED'); END;

/* Full output manifests live in immutable Git inputs, not one large D1 row per job. */
CREATE TRIGGER publication_build_immutable BEFORE UPDATE OF build_json ON publication_runs
WHEN OLD.build_json IS NOT NULL AND NEW.build_json IS NOT OLD.build_json
BEGIN SELECT RAISE(ABORT,'PUBLICATION_BUILD_CHANGED'); END;
CREATE TRIGGER publication_deployment_immutable BEFORE UPDATE OF deployment_json ON publication_runs
WHEN OLD.deployment_json IS NOT NULL AND NEW.deployment_json IS NOT OLD.deployment_json
BEGIN SELECT RAISE(ABORT,'PUBLICATION_DEPLOYMENT_CHANGED'); END;
