#!/usr/bin/env bash
set -Eeuo pipefail

service=pointsite-builder.service
container=pointsite-builder
app=/opt/pointsite-builder/app
wrapper=/usr/local/sbin/pointsite-builder-run
unit=/etc/systemd/system/pointsite-builder.service
backups=/opt/pointsite-builder/backups/native
image_prefix=localhost/pointsite-builder:
builder_image=docker.io/library/node:22.23.2-bookworm@sha256:ae9f58d5c9f5a537110310be6b3cf67cf9c67146a3bb9310c0cb515fe71c8392
sha_pattern='^[a-f0-9]{40}$'
hash_pattern='^[a-f0-9]{64}$'

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}
[[ $(id -u) == 0 ]] || fail ROOT_REQUIRED
[[ ${1-} == inspect || ${1-} == deploy || ${1-} == rollback ]] || fail INVALID_ACTION
action=$1

check_mounts() {
  local data_source recovery_source backup_source backup_target
  data_source=$(findmnt -T /opt/pointsite-builder/data/workspace -no SOURCE)
  recovery_source=$(findmnt -T /opt/pointsite-builder/recovery/control -no SOURCE)
  backup_source=$(findmnt -T "$backups" -no SOURCE)
  backup_target=$(findmnt -T "$backups" -no TARGET)
  [[ $backup_target == /opt/pointsite-builder/backups && $backup_source == /dev/sdc ]] || fail BACKUP_MOUNT_REQUIRED
  [[ $(findmnt -T "$backups" -no FSTYPE) == ext4 ]] || fail BACKUP_FILESYSTEM_REQUIRED
  [[ $backup_source != "$data_source" && $backup_source != "$recovery_source" ]] || fail OFF_VOLUME_BACKUP_REQUIRED
}

local_health() {
  curl -fsS --max-time 10 -o /dev/null -H 'Host: builder.eaglepass.io' http://127.0.0.1:3000/healthz
  curl -fsS --max-time 10 -o /dev/null -H 'Host: builder.eaglepass.io' http://127.0.0.1:3000/readyz
}

backup_id() {
  podman exec "$container" node /app/dist/server/operator.js status |
    python3 -c 'import json,sys; s=json.load(sys.stdin); b=s["backup"]; print(b["last_success_id"] or "") if s["recovery"]["mode"] == "active" and b["state"] == "succeeded" else sys.exit("RECOVERY_OR_BACKUP_NOT_READY")'
}

fresh_backup() {
  local before after
  before=$(backup_id)
  podman exec "$container" node /app/dist/server/operator.js backup >/dev/null
  after=$(backup_id)
  [[ -n $after && $after != "$before" && -f $backups/$after/manifest.json ]] || fail FRESH_BACKUP_REQUIRED
  printf '%s' "$after"
}

wrapper_image() {
  python3 - "$wrapper" <<'PY'
import re, sys
matches = re.findall(rb'localhost/pointsite-builder:[a-f0-9]{40}', open(sys.argv[1], 'rb').read())
if len(matches) != 1:
    raise SystemExit('ONE_PINNED_IMAGE_REQUIRED')
print(matches[0].decode())
PY
}

if [[ $action == rollback ]]; then
  current_image=${2-}
  restore_image=${3-}
  restore_wrapper=${4-}
  restore_revision=${5-}
  [[ $current_image =~ ^localhost/pointsite-builder:[a-f0-9]{40}$ ]] || fail EXACT_CURRENT_IMAGE_REQUIRED
  [[ $restore_image =~ ^localhost/pointsite-builder:[a-f0-9]{40}$ ]] || fail EXACT_RESTORE_IMAGE_REQUIRED
  [[ $restore_wrapper =~ ^/usr/local/sbin/pointsite-builder-run\.bak-[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || fail EXACT_WRAPPER_BACKUP_REQUIRED
  [[ $restore_revision =~ $sha_pattern ]] || fail EXACT_RESTORE_SOURCE_REQUIRED
  [[ $(wrapper_image) == "$current_image" && -f $restore_wrapper ]] || fail CURRENT_IMAGE_CHANGED
  [[ $(python3 - "$restore_wrapper" <<'PY'
import re, sys
matches = re.findall(rb'localhost/pointsite-builder:[a-f0-9]{40}', open(sys.argv[1], 'rb').read())
if len(matches) != 1:
    raise SystemExit('ONE_RESTORE_IMAGE_REQUIRED')
print(matches[0].decode())
PY
) == "$restore_image" ]] || fail RESTORE_IMAGE_CHANGED
  cp -a -- "$restore_wrapper" "$wrapper"
  systemctl restart "$service"
  ready=0
  for _ in {1..30}; do
    if systemctl is-active --quiet "$service" && local_health >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [[ $ready == 1 ]] || fail ROLLBACK_HEALTH_FAILED
  [[ $(podman inspect --format '{{.ImageName}}' "$container") == "$restore_image" ]] || fail ROLLBACK_IMAGE_FAILED
  check_mounts
  git -C "$app" checkout --detach "$restore_revision" >/dev/null
  curl -fsS --max-time 20 -o /dev/null https://builder.eaglepass.io/api/health
  curl -fsS --max-time 20 -o /dev/null https://builder-canary.eaglepass.io/api/health
  printf '{"status":"rolled_back","image":"%s","sourceRevision":"%s"}\n' "$restore_image" "$restore_revision"
  exit 0
fi

preflight() {
  [[ -f $wrapper && -f $unit && -d $app && -d $app/.git ]] || fail LINODE_RUNTIME_REQUIRED
  systemctl is-active --quiet "$service" || fail HEALTHY_SERVICE_REQUIRED
  check_mounts
  local_health
  [[ -z $(git -C "$app" status --porcelain --untracked-files=all) ]] || fail CLEAN_LINODE_SOURCE_REQUIRED
  previous_image=$(wrapper_image)
  [[ $(podman inspect --format '{{.ImageName}}' "$container") == "$previous_image" ]] || fail RUNNING_IMAGE_MISMATCH
  previous_id=$(podman inspect --format '{{.Image}}' "$container")
  wrapper_hash=$(sha256sum "$wrapper"); wrapper_hash=${wrapper_hash%% *}
  unit_hash=$(sha256sum "$unit"); unit_hash=${unit_hash%% *}
}

preflight
if [[ $action == inspect ]]; then
  printf '{"wrapperHash":"%s","unitHash":"%s","previousImage":"%s","previousImageId":"%s"}\n' \
    "$wrapper_hash" "$unit_hash" "$previous_image" "$previous_id"
  exit 0
fi

main_revision=${2-}
approved_tree=${3-}
expected_wrapper_hash=${4-}
expected_unit_hash=${5-}
[[ $main_revision =~ $sha_pattern && $approved_tree =~ $sha_pattern ]] || fail EXACT_SOURCE_REQUIRED
[[ $expected_wrapper_hash =~ $hash_pattern && $expected_unit_hash =~ $hash_pattern ]] || fail EXACT_RUNTIME_REQUIRED
[[ $wrapper_hash == "$expected_wrapper_hash" && $unit_hash == "$expected_unit_hash" ]] || fail RUNTIME_CHANGED
[[ $(git -C "$app" remote get-url origin) =~ ^(https://github.com/|git@github.com:)PointCommunity/pointsite-builder(\.git)?$ ]] || fail CANONICAL_SOURCE_REQUIRED

previous_revision=$(git -C "$app" rev-parse HEAD)
saved_wrapper=
switched=0
rollback() {
  local failed=$?
  trap - EXIT HUP INT TERM
  [[ $failed != 0 ]] || return 0
  set +e
  if [[ $switched == 1 ]]; then
    if cp -a -- "$saved_wrapper" "$wrapper" &&
      systemctl restart "$service" &&
      local_health &&
      (check_mounts) &&
      [[ $(podman inspect --format '{{.ImageName}}' "$container") == "$previous_image" ]]; then
      printf 'Linode release failed; previous image restored and verified: %s\n' "$previous_image" >&2
    else
      printf 'Linode release failed; automatic rollback incomplete; inspect service and restore %s\n' "$previous_image" >&2
    fi
  fi
  git -C "$app" checkout --detach "$previous_revision" >/dev/null ||
    printf 'Linode source checkout restore failed: %s\n' "$previous_revision" >&2
  exit "$failed"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

pre_backup=$(fresh_backup)
git -C "$app" fetch --prune origin >/dev/null
[[ $(git -C "$app" rev-parse origin/main) == "$main_revision" ]] || fail MERGED_MAIN_CHANGED
git -C "$app" checkout --detach "$main_revision" >/dev/null
[[ $(git -C "$app" rev-parse 'HEAD^{tree}') == "$approved_tree" ]] || fail APPROVED_TREE_CHANGED
[[ -z $(git -C "$app" status --porcelain --untracked-files=all) ]] || fail DIRTY_RELEASE_SOURCE

podman run --rm --platform linux/amd64 -v "$app:/app" -w /app "$builder_image" \
  bash -lc 'npm ci && npm run build:native' >/dev/null
python3 - "$app/dist/release.json" "$main_revision" "$approved_tree" <<'PY'
import json, sys
release = json.load(open(sys.argv[1]))
if release.get('sourceClean') is not True or release.get('sourceRevision') != sys.argv[2] or release.get('gitTree') != sys.argv[3]:
    raise SystemExit('BUILT_SOURCE_MISMATCH')
PY
[[ -z $(git -C "$app" status --porcelain --untracked-files=all) ]] || fail SOURCE_CHANGED_DURING_BUILD

new_image=$image_prefix$main_revision
podman build --quiet --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$main_revision" \
  --label "io.eaglepass.builder.tree=$approved_tree" \
  -t "$new_image" -f "$app/Containerfile" "$app" >/dev/null
[[ $(podman image inspect --format '{{ index .Labels "org.opencontainers.image.revision" }}' "$new_image") == "$main_revision" ]] || fail IMAGE_REVISION_MISMATCH
[[ $(podman image inspect --format '{{ index .Labels "io.eaglepass.builder.tree" }}' "$new_image") == "$approved_tree" ]] || fail IMAGE_TREE_MISMATCH
new_id=$(podman image inspect --format '{{.Id}}' "$new_image")

saved_wrapper=$wrapper.bak-$(date -u +%Y%m%dT%H%M%SZ)-$$
[[ ! -e $saved_wrapper ]] || fail WRAPPER_BACKUP_EXISTS
cp -a -- "$wrapper" "$saved_wrapper"
switched=1
python3 - "$wrapper" "$previous_image" "$new_image" <<'PY'
import os, re, stat, sys, tempfile
path, old, new = sys.argv[1:]
with open(path, 'rb') as source:
    content = source.read()
pattern = rb'localhost/pointsite-builder:[a-f0-9]{40}'
if re.findall(pattern, content) != [old.encode()]:
    raise SystemExit('PINNED_IMAGE_CHANGED')
info = os.stat(path)
fd, temporary = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.pointsite-builder-run-')
try:
    os.fchmod(fd, stat.S_IMODE(info.st_mode))
    os.fchown(fd, info.st_uid, info.st_gid)
    with os.fdopen(fd, 'wb') as output:
        output.write(content.replace(old.encode(), new.encode(), 1))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
except BaseException:
    if os.path.exists(temporary):
        os.unlink(temporary)
    raise
PY
[[ $(wrapper_image) == "$new_image" ]] || fail IMAGE_PIN_FAILED
systemd-analyze verify "$unit" >/dev/null
systemctl restart "$service"
ready=0
for _ in {1..30}; do
  if systemctl is-active --quiet "$service" && local_health >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ $ready == 1 ]] || fail LINODE_HEALTH_FAILED
[[ $(podman inspect --format '{{.ImageName}}' "$container") == "$new_image" ]] || fail RUNNING_IMAGE_MISMATCH
[[ $(podman inspect --format '{{.Image}}' "$container") == "$new_id" ]] || fail RUNNING_IMAGE_ID_MISMATCH
check_mounts
post_backup=$(fresh_backup)

curl -fsS --max-time 20 https://builder.eaglepass.io/api/health |
  python3 -c 'import json,sys; h=json.load(sys.stdin); assert h.get("ok") is True and h.get("environment") == "production" and h.get("sourceRevision") == sys.argv[1] and h.get("gitTree") == sys.argv[2], "PRODUCTION_SOURCE_MISMATCH"' "$main_revision" "$approved_tree"
curl -fsS --max-time 20 https://builder-canary.eaglepass.io/api/health |
  python3 -c 'import json,sys; h=json.load(sys.stdin); assert h.get("ok") is True and h.get("environment") == "canary", "CANARY_ROUTE_FAILED"'

printf '{"previousImage":"%s","previousImageId":"%s","previousRevision":"%s","newImage":"%s","newImageId":"%s","preBackupId":"%s","postBackupId":"%s","wrapperBackup":"%s","sourceRevision":"%s","gitTree":"%s"}\n' \
  "$previous_image" "$previous_id" "$previous_revision" "$new_image" "$new_id" "$pre_backup" "$post_backup" "$saved_wrapper" "$main_revision" "$approved_tree"
