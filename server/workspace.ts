import { lstat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { SqliteDatabase } from './sqlite';
import { migrateDatabase } from './migrations';
import { createBuilderRuntime } from '../src/server/application';
import { createNativeHandler, createPublicAssets } from './http';
import { openRecoveryDatabase } from '../src/server/maintenance/recovery-control';
import type { RuntimeConfig } from '../src/server/config';
import type { AppDependencies } from '../src/server';
import { bindInstance, bootstrapAdministrator } from './identity';
import { captureProductionSource } from './production-source';
import { createBackups } from './backups';
import { ROLLBACK_PRODUCTION_CALLER_BLOB } from '../src/server/publish/renderer-contract';
import { FeedbackService, type FeedbackConfig } from '../src/server/feedback/service';

export async function openNativeWorkspace(options: {
  workspacePath: string;
  recoveryPath: string;
  backupRoot?: string;
  migrationRoot: string;
  publicRoot: string;
  config: RuntimeConfig;
  feedbackConfig?: FeedbackConfig;
  release: NonNullable<AppDependencies['release']>;
}) {
  if (options.config.runtime !== 'node') throw new Error('NATIVE_RUNTIME_REQUIRED');
  if (options.config.environment !== 'local' && !options.backupRoot)
    throw new Error('BACKUP_DIRECTORY_REQUIRED');
  const { workspacePath, recoveryPath } = options;
  if (
    ![workspacePath, recoveryPath].every(isAbsolute) ||
    resolve(workspacePath) === resolve(recoveryPath) ||
    dirname(workspacePath) === dirname(recoveryPath)
  )
    throw new Error('INDEPENDENT_DATABASE_PATHS_REQUIRED');
  for (const file of [workspacePath, recoveryPath]) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o007) !== 0) {
      throw new Error('PRIVATE_DATABASE_DIRECTORY_REQUIRED');
    }
  }
  const workspace = new SqliteDatabase(workspacePath);
  let recovery: SqliteDatabase | undefined;
  try {
    recovery = new SqliteDatabase(recoveryPath);
    await migrateDatabase(workspace, resolve(options.migrationRoot, 'migrations'));
    await migrateDatabase(recovery, resolve(options.migrationRoot, 'recovery-migrations'));
    await bindInstance(workspace, recovery, options.config.builderOrigin);
    if (options.config.environment !== 'local') await bootstrapAdministrator(workspace);
    const backups = options.backupRoot
      ? await createBackups({
          workspace,
          control: recovery,
          root: options.backupRoot,
          origin: options.config.builderOrigin,
          workspacePath,
          requireOffVolume: options.config.environment !== 'local',
        })
      : undefined;
    await backups?.due();
    const runtime = createBuilderRuntime({
      workspace,
      recovery,
      config: options.config,
      release: options.release,
      ...(options.feedbackConfig
        ? {
            feedback: new FeedbackService(
              options.feedbackConfig,
              options.config.appVersion,
              options.release.sourceRevision,
            ),
          }
        : {}),
      rollbackCallerBlob: ROLLBACK_PRODUCTION_CALLER_BLOB,
      assets: createPublicAssets(options.publicRoot),
      ...(options.config.environment !== 'local'
        ? { productionSource: captureProductionSource }
        : {}),
      nativeStorage: backups
        ? () => backups.status()
        : () =>
            Promise.resolve({
              engine: 'sqlite',
              offVolume: false,
              backup: { state: 'never', checkedAt: null, lastSucceededAt: null },
            }),
      sessionEpoch: async () => {
        const epoch = await recovery!
          .prepare("SELECT epoch FROM workspace_recovery WHERE id=1 AND mode='active'")
          .first<number>('epoch');
        if (!epoch) throw new Error('SESSION_EPOCH_UNAVAILABLE');
        return epoch;
      },
    });
    const ready = async () => {
      const database = await openRecoveryDatabase(workspace, recovery);
      await database.prepare('SELECT id FROM drafts LIMIT 1').first();
    };
    return {
      workspace,
      recovery,
      runtime,
      backups,
      fetch: createNativeHandler({
        origin: options.config.builderOrigin,
        publicRoot: options.publicRoot,
        runtime,
        ready,
        feedbackOrigin: options.feedbackConfig?.POINTVIEW_ORIGIN,
      }),
      close: () => {
        workspace.close();
        recovery!.close();
      },
    };
  } catch (error) {
    workspace.close();
    recovery?.close();
    throw error;
  }
}
