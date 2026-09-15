// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { SqliteDatabase } from '../../server/sqlite';
import { migrateDatabase } from '../../server/migrations';
import { bindInstance } from '../../server/identity';
import { createBackups } from '../../server/backups';
import { restoreWorkspace } from '../../server/restore';
import { operate } from '../../server/operator';
import { quarantineWorkspace } from '../../src/server/maintenance/recovery-control';
import { D1DeletionReceipts } from '../../src/server/maintenance/deletion-receipts';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { defaultSiteDocument } from '../../src/site-kit/default-site';

test('restoring an older workspace replays later deletions, fences checkouts, and refuses authority rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'builder-native-restore-'));
  await mkdir(join(directory, 'workspace'));
  await mkdir(join(directory, 'recovery'));
  const workspacePath = join(directory, 'workspace/workspace.sqlite');
  const workspace = new SqliteDatabase(workspacePath);
  const control = new SqliteDatabase(join(directory, 'recovery/control.sqlite'));
  try {
    await migrateDatabase(workspace, 'migrations');
    await migrateDatabase(control, 'recovery-migrations');
    const origin = 'https://builder-canary.eaglepass.io';
    await bindInstance(workspace, control, origin);
    for (const actor of ['github:123', 'github:456'])
      await workspace
        .prepare(
          "INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by) VALUES (?,'administrator',1,'fixture','fixture','fixture')",
        )
        .bind(actor)
        .run();
    const receipts = new D1DeletionReceipts(workspace, control);
    const repository = new D1DraftRepository(workspace, undefined, 'compact-v1', receipts);
    const create = (actor: string) =>
      repository.createDraft({
        name: actor,
        document: defaultSiteDocument,
        actor,
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      });
    const kept = await create('github:123'),
      deleted = await create('github:456');
    const checkout = await repository.acquireCheckout({
      draftId: kept.id,
      actor: 'github:123',
      clientId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
    });
    const root = join(directory, 'backups');
    const backups = await createBackups({
      workspace,
      control,
      workspacePath,
      root,
      origin,
      requireOffVolume: false,
    });
    await backups.run();
    const backupId = (await readdir(root)).find((name) => name !== 'instance.json')!;
    const document = structuredClone(kept.document);
    document.site.name = 'After backup';
    await repository.saveDraft({
      draftId: kept.id,
      document,
      actor: 'github:123',
      idempotencyKey: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      expectedRevisionId: kept.latestRevisionId,
      expectedChecksum: kept.revision.checksum,
      checkoutToken: checkout.token,
      action: { category: 'text-edit', context: 'site-settings' },
    });
    const deleting = await repository.acquireCheckout({
      draftId: deleted.id,
      actor: 'github:456',
      clientId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
    });
    const proof = {
      expectedRevisionId: deleted.latestRevisionId,
      expectedChecksum: deleted.revision.checksum,
      checkoutToken: deleting.token,
    };
    await repository.setDraftStatus(
      deleted.id,
      'archived',
      'github:456',
      crypto.randomUUID(),
      proof,
    );
    const archivedCheckout = await repository.acquireCheckout({
      draftId: deleted.id,
      actor: 'github:456',
      clientId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      expectedStatus: 'archived',
    });
    await repository.purgeDraft(deleted.id, 'github:456', crypto.randomUUID(), {
      ...proof,
      checkoutToken: archivedCheckout.token,
    });
    const recoveryId = crypto.randomUUID();
    const environment = {
      DATA_DIRECTORY: join(directory, 'workspace'),
      RECOVERY_DIRECTORY: join(directory, 'recovery'),
      BACKUP_DIRECTORY: root,
      BUILDER_ORIGIN: origin,
    };
    await expect(operate(['restore'], environment)).rejects.toThrow('USAGE');
    await expect(
      operate(['status'], { ...environment, BUILDER_ORIGIN: 'https://builder.eaglepass.io' }),
    ).rejects.toThrow('BUILDER_INSTANCE_MISMATCH');
    await expect(operate(['backup'], environment)).rejects.toThrow('OFF_VOLUME_BACKUP_REQUIRED');
    expect(await operate(['quarantine', '1', recoveryId], environment)).toMatchObject({
      epoch: 2,
      mode: 'quarantined',
    });
    expect(await operate(['restore', backupId, '2', recoveryId], environment)).toMatchObject({
      epoch: 3,
    });
    expect(await operate(['status'], environment)).toMatchObject({
      recovery: { mode: 'active', epoch: 3 },
    });
    expect((await repository.getDraft(kept.id)).document.site.name).toBe(kept.document.site.name);
    await expect(repository.getDraft(deleted.id)).rejects.toThrow();
    expect(
      await workspace.prepare('SELECT COUNT(*) AS count FROM draft_checkouts').first('count'),
    ).toBe(0);
    expect(await control.prepare('SELECT epoch,mode FROM workspace_recovery').first()).toEqual({
      epoch: 3,
      mode: 'active',
    });
    expect(
      await control
        .prepare("SELECT COUNT(*) AS count FROM deletion_receipts WHERE state='committed'")
        .first('count'),
    ).toBe(1);
    // A revoked role may never be resurrected from the same backup.
    await workspace.prepare("UPDATE user_roles SET active=0 WHERE email='github:456'").run();
    const secondId = crypto.randomUUID();
    await quarantineWorkspace(control, 3, secondId);
    await expect(
      restoreWorkspace({
        workspace,
        control,
        backupRoot: root,
        backupId,
        recoveryId: secondId,
        epoch: 4,
      }),
    ).rejects.toThrow('WORKSPACE_RECOVERY_PROTECTED_STATE');
    expect(
      await workspace
        .prepare("SELECT active FROM user_roles WHERE email='github:456'")
        .first('active'),
    ).toBe(0);
    expect(await control.prepare('SELECT mode FROM workspace_recovery').first('mode')).toBe(
      'quarantined',
    );
    await writeFile(join(root, backupId, 'workspace.sqlite'), 'corrupt');
    await expect(
      restoreWorkspace({
        workspace,
        control,
        backupRoot: root,
        backupId,
        recoveryId: secondId,
        epoch: 4,
      }),
    ).rejects.toThrow('BACKUP_CHECKSUM_CHANGED');
  } finally {
    workspace.close();
    control.close();
    await rm(directory, { recursive: true });
  }
});
