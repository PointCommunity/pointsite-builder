import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { SqliteDatabase } from './sqlite';
import { createBackups } from './backups';
import { restoreWorkspace } from './restore';
import { quarantineWorkspace } from '../src/server/maintenance/recovery-control';

/** Local operator access inside the environment's pod; never exposed as an HTTP route. */
export async function operate(
  args: string[],
  environment: Record<string, string | undefined> = process.env,
) {
  const [command, ...values] = args;
  if (
    !['status', 'backup', 'quarantine', 'restore'].includes(command) ||
    values.length !== { status: 0, backup: 0, quarantine: 2, restore: 3 }[command]
  )
    throw new Error(
      'USAGE: status | backup | quarantine CURRENT_EPOCH RECOVERY_ID | restore BACKUP_ID QUARANTINED_EPOCH RECOVERY_ID',
    );
  const config = z
    .object({
      DATA_DIRECTORY: z.string().startsWith('/'),
      RECOVERY_DIRECTORY: z.string().startsWith('/'),
      BACKUP_DIRECTORY: z.string().startsWith('/'),
      BUILDER_ORIGIN: z.enum([
        'https://builder-canary.eaglepass.io',
        'https://builder.eaglepass.io',
      ]),
    })
    .parse(environment);
  const paths = [
    join(config.DATA_DIRECTORY, 'workspace.sqlite'),
    join(config.RECOVERY_DIRECTORY, 'control.sqlite'),
  ];
  if (
    resolve(paths[0]) === resolve(paths[1]) ||
    resolve(config.DATA_DIRECTORY) === resolve(config.RECOVERY_DIRECTORY)
  )
    throw new Error('INDEPENDENT_DATABASE_PATHS_REQUIRED');
  // Operator mistakes must not create a replacement empty database.
  for (const path of paths) {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1)
      throw new Error('EXISTING_PRIVATE_DATABASE_REQUIRED');
  }
  const workspace = new SqliteDatabase(paths[0]);
  let control: SqliteDatabase | undefined;
  try {
    control = new SqliteDatabase(paths[1]);
    const identity = await workspace
      .prepare('SELECT origin,instance_id FROM builder_instance WHERE id=1')
      .first<{ origin: string; instance_id: string }>();
    const authority = await control
      .prepare('SELECT origin,instance_id FROM builder_instance WHERE id=1')
      .first();
    if (
      !identity ||
      identity.origin !== config.BUILDER_ORIGIN ||
      JSON.stringify(identity) !== JSON.stringify(authority)
    )
      throw new Error('BUILDER_INSTANCE_MISMATCH');
    if (command === 'quarantine')
      return await quarantineWorkspace(
        control,
        z.coerce.number().int().positive().parse(values[0]),
        z.uuid().parse(values[1]),
      );
    if (command === 'restore')
      return await restoreWorkspace({
        workspace,
        control,
        backupRoot: config.BACKUP_DIRECTORY,
        backupId: z.uuid().parse(values[0]),
        epoch: z.coerce.number().int().positive().parse(values[1]),
        recoveryId: z.uuid().parse(values[2]),
      });
    const state = await control
      .prepare('SELECT epoch,mode,leased_until,recovery_id FROM workspace_recovery WHERE id=1')
      .first();
    if (command === 'backup') {
      const backups = await createBackups({
        workspace,
        control,
        workspacePath: paths[0],
        root: config.BACKUP_DIRECTORY,
        origin: config.BUILDER_ORIGIN,
        requireOffVolume: true,
      });
      await backups.run();
    }
    return {
      ...identity,
      recovery: state,
      backup: await control
        .prepare(
          'SELECT state,checked_at,last_success_at,last_success_id FROM native_backup_state WHERE id=1',
        )
        .first(),
    };
  } finally {
    workspace.close();
    control?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  operate(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      // Print only fixed operator error codes. SQL errors can contain private content.
      console.error(
        JSON.stringify({
          event: 'operator_failed',
          code:
            error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message)
              ? error.message
              : 'INVALID_OR_UNAVAILABLE_OPERATION',
        }),
      );
      process.exitCode = 1;
    });
}
