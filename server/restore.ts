import { DatabaseSync, backup } from 'node:sqlite';
import { lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { BackupManifest, fileIdentity } from './backups';
import { SqliteDatabase } from './sqlite';
import { assertRecoveryDrained } from '../src/server/maintenance/recovery-control';
import { D1DeletionReceipts } from '../src/server/maintenance/deletion-receipts';
import { D1WorkspaceRecovery } from '../src/server/maintenance/workspace-recovery';
import { checksumDocument } from '../src/site-kit/canonicalize';

/** Restore a selected workspace only. Independent live recovery authority is never restored. */
export async function restoreWorkspace(input: {
  workspace: SqliteDatabase;
  control: SqliteDatabase;
  backupRoot: string;
  backupId: string;
  recoveryId: string;
  epoch: number;
}) {
  z.uuid().parse(input.backupId);
  z.uuid().parse(input.recoveryId);
  await assertRecoveryDrained(input.workspace, input.control, input.epoch, input.recoveryId);
  const root = await lstat(input.backupRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o007) !== 0)
    throw new Error('PRIVATE_BACKUP_DIRECTORY_REQUIRED');
  const selected = join(input.backupRoot, input.backupId);
  if (!(await lstat(selected)).isDirectory() || (await lstat(selected)).isSymbolicLink())
    throw new Error('BACKUP_FILE_UNSAFE');
  const manifestPath = join(selected, 'manifest.json');
  if ((await lstat(manifestPath)).size > 4096 || (await lstat(manifestPath)).isSymbolicLink())
    throw new Error('BACKUP_FILE_UNSAFE');
  const manifest = BackupManifest.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const started = Date.parse(manifest.startedAt),
    completed = Date.parse(manifest.completedAt);
  if (
    manifest.id !== input.backupId ||
    started > completed ||
    completed > Date.now() ||
    Date.now() - started > 35 * 86_400_000
  )
    throw new Error('BACKUP_OUTSIDE_RECOVERY_WINDOW');
  const instance = await input.control
    .prepare('SELECT instance_id,origin FROM builder_instance WHERE id=1')
    .first<{ instance_id: string; origin: string }>();
  if (
    !instance ||
    instance.instance_id !== manifest.instanceId ||
    instance.origin !== manifest.origin
  )
    throw new Error('BACKUP_INSTANCE_MISMATCH');
  const sourcePath = join(selected, 'workspace.sqlite');
  const verifySource = async () => {
    if (JSON.stringify(await fileIdentity(sourcePath)) !== JSON.stringify(manifest.workspace))
      throw new Error('BACKUP_CHECKSUM_CHANGED');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = await lstat(sourcePath + suffix).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
      });
      if (sidecar) throw new Error('BACKUP_SIDECAR_UNCONFIRMED');
    }
  };
  await verifySource();
  const receipts = new D1DeletionReceipts(input.workspace, input.control);
  while ((await receipts.settlePending(input.epoch, input.recoveryId)).settled) {
    /* Bounded SQL pages, quarantined writer. */
  }
  const busy = await input.workspace
    .prepare(
      `SELECT 1 FROM publish_jobs WHERE status IN ('queued','running')
    UNION ALL SELECT 1 FROM publication_verifications WHERE status IN ('queued','running')
    UNION ALL SELECT 1 FROM publication_rollbacks WHERE status IN ('queued','running') LIMIT 1`,
    )
    .first();
  if (busy) throw new Error('WORKSPACE_RECOVERY_PUBLICATION_ACTIVE');
  const manifestHash = await checksumDocument(manifest);
  const existing = await input.control
    .prepare('SELECT backup_id,manifest_hash FROM native_restore_runs WHERE id=? AND epoch=?')
    .bind(input.recoveryId, input.epoch)
    .first<{ backup_id: string; manifest_hash: string }>();
  if (
    existing &&
    (existing.backup_id !== input.backupId || existing.manifest_hash !== manifestHash)
  )
    throw new Error('RESTORE_SELECTION_CHANGED');
  await writeFile(join(selected, 'pinned'), input.recoveryId + '\n', {
    flag: 'wx',
    mode: 0o600,
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  if (!existing)
    await input.control
      .prepare(
        "INSERT INTO native_restore_runs(id,epoch,backup_id,manifest_hash,phase) VALUES (?,?,?,?,'prepared')",
      )
      .bind(input.recoveryId, input.epoch, input.backupId, manifestHash)
      .run();
  const temporary = await mkdtemp(join(tmpdir(), 'builder-restore-'));
  let restored: SqliteDatabase | undefined;
  try {
    const target = join(temporary, 'workspace.sqlite');
    const file = await open(target, 'wx', 0o600);
    await file.close();
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      await backup(source, target);
    } finally {
      source.close();
    }
    await verifySource();
    restored = new SqliteDatabase(target);
    const restoredInstance = await restored
      .prepare('SELECT instance_id,origin FROM builder_instance WHERE id=1')
      .first();
    if (JSON.stringify(restoredInstance) !== JSON.stringify(instance))
      throw new Error('BACKUP_INSTANCE_MISMATCH');
    let cursor = '';
    for (;;) {
      const rows = (
        await input.control
          .prepare(
            "SELECT id FROM deletion_receipts WHERE state='committed' AND id>? ORDER BY id LIMIT 100",
          )
          .bind(cursor)
          .all<{ id: string }>()
      ).results;
      if (!rows.length) break;
      for (const row of rows)
        await new D1DeletionReceipts(restored, input.control).replay(
          input.epoch,
          input.recoveryId,
          row.id,
        );
      cursor = rows.at(-1)!.id;
    }
    const protectedState = await new D1WorkspaceRecovery(
      input.workspace,
      input.control,
    ).protectedHash();
    if ((await new D1WorkspaceRecovery(restored, input.control).protectedHash()) !== protectedState)
      throw new Error('WORKSPACE_RECOVERY_PROTECTED_STATE');
    await restored.batch([
      restored.prepare('DELETE FROM draft_checkouts'),
      restored.prepare('DELETE FROM publish_preflights'),
    ]);
    if (
      (await restored.prepare('PRAGMA integrity_check').first('integrity_check')) !== 'ok' ||
      (await restored.prepare('PRAGMA foreign_key_check').all()).results.length
    )
      throw new Error('WORKSPACE_RECOVERY_INTEGRITY');
    await assertRecoveryDrained(input.workspace, input.control, input.epoch, input.recoveryId);
    await input.workspace.replaceFrom(restored);
    if (
      (await new D1WorkspaceRecovery(input.workspace, input.control).protectedHash()) !==
        protectedState ||
      (await input.workspace.prepare('PRAGMA integrity_check').first('integrity_check')) !== 'ok'
    )
      throw new Error('WORKSPACE_RECOVERY_INTEGRITY');
    await input.control.batch([
      input.control
        .prepare(
          `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM workspace_recovery
        WHERE id=1 AND mode='quarantined' AND epoch=? AND recovery_id=?) THEN 'true' ELSE 'recovery-changed' END)`,
        )
        .bind(input.epoch, input.recoveryId),
      input.control
        .prepare(
          "UPDATE native_restore_runs SET phase='complete',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND epoch=?",
        )
        .bind(input.recoveryId, input.epoch),
      input.control
        .prepare(
          "UPDATE workspace_recovery SET mode='active',epoch=epoch+1,recovery_id=NULL WHERE id=1 AND epoch=? AND recovery_id=?",
        )
        .bind(input.epoch, input.recoveryId),
    ]);
    return { backupId: input.backupId, recoveryId: input.recoveryId, epoch: input.epoch + 1 };
  } finally {
    restored?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
