import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { SqliteDatabase } from './sqlite';

const fileSchema = z.strictObject({
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const BackupManifest = z.strictObject({
  format: z.literal(1),
  id: z.uuid(),
  origin: z.url(),
  instanceId: z.uuid(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  workspace: fileSchema,
  control: fileSchema,
});
export async function fileIdentity(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error('BACKUP_FILE_UNSAFE');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return { bytes: info.size, sha256: hash.digest('hex') };
}
async function syncDirectory(path: string) {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Newest successful copy per day/week; pinned restore evidence is never pruned. */
export function retainedBackups(items: { id: string; completedAt: string; pinned: boolean }[]) {
  const retained = new Set<string>();
  const days = new Set<string>();
  const weeks = new Set<number>();
  for (const item of [...items].sort((a, b) => b.completedAt.localeCompare(a.completedAt))) {
    const day = item.completedAt.slice(0, 10);
    const week = Math.floor((Date.parse(day) / 86_400_000 + 3) / 7); // Monday boundary.
    if (item.pinned) retained.add(item.id);
    if (!days.has(day) && days.size < 7) {
      days.add(day);
      retained.add(item.id);
    }
    if (!weeks.has(week) && weeks.size < 4) {
      weeks.add(week);
      retained.add(item.id);
    }
  }
  return retained;
}

export async function createBackups(options: {
  workspace: SqliteDatabase;
  control: SqliteDatabase;
  root: string;
  origin: string;
  workspacePath: string;
  requireOffVolume: boolean;
}) {
  if (!isAbsolute(options.root)) throw new Error('ABSOLUTE_BACKUP_DIRECTORY_REQUIRED');
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const root = await lstat(options.root);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o007) !== 0)
    throw new Error('PRIVATE_BACKUP_DIRECTORY_REQUIRED');
  if (options.requireOffVolume && root.dev === (await stat(options.workspacePath)).dev)
    throw new Error('OFF_VOLUME_BACKUP_REQUIRED');
  const instance = await options.workspace
    .prepare('SELECT instance_id,origin FROM builder_instance WHERE id=1')
    .first<{ instance_id: string; origin: string }>();
  if (!instance || instance.origin !== options.origin) throw new Error('BACKUP_INSTANCE_MISMATCH');
  const markerPath = join(options.root, 'instance.json');
  try {
    await writeFile(markerPath, JSON.stringify(instance), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (
    (await lstat(markerPath)).isSymbolicLink() ||
    JSON.stringify(JSON.parse(await readFile(markerPath, 'utf8'))) !== JSON.stringify(instance)
  )
    throw new Error('BACKUP_INSTANCE_MISMATCH');
  let running: Promise<void> | undefined;
  const run = async () => {
    if (running) return running;
    running = (async () => {
      const startedAt = new Date().toISOString();
      await options.control
        .prepare("UPDATE native_backup_state SET state='running',checked_at=? WHERE id=1")
        .bind(startedAt)
        .run();
      const id = randomUUID();
      const temporary = join(options.root, `.pending-${id}`);
      try {
        await mkdir(temporary, { mode: 0o700 });
        await options.workspace.backupTo(join(temporary, 'workspace.sqlite'));
        // Recovery authority is captured after its workspace, never restored over live authority.
        await options.control.backupTo(join(temporary, 'control.sqlite'));
        const completedAt = new Date().toISOString();
        const manifest = BackupManifest.parse({
          format: 1,
          id,
          origin: options.origin,
          instanceId: instance.instance_id,
          startedAt,
          completedAt,
          workspace: await fileIdentity(join(temporary, 'workspace.sqlite')),
          control: await fileIdentity(join(temporary, 'control.sqlite')),
        });
        const file = await open(join(temporary, 'manifest.json'), 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(manifest));
          await file.sync();
        } finally {
          await file.close();
        }
        await syncDirectory(temporary);
        await rename(temporary, join(options.root, id));
        await syncDirectory(options.root);
        await options.control
          .prepare(
            "UPDATE native_backup_state SET state='succeeded',checked_at=?,last_success_at=?,last_success_id=? WHERE id=1",
          )
          .bind(completedAt, completedAt, id)
          .run();
        const items = [];
        for (const entry of await readdir(options.root, { withFileTypes: true })) {
          if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
          const directory = join(options.root, entry.name);
          const retained = BackupManifest.parse(
            JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')),
          );
          if (
            retained.id !== entry.name ||
            retained.instanceId !== instance.instance_id ||
            retained.origin !== options.origin
          )
            throw new Error('BACKUP_INSTANCE_MISMATCH');
          const pinned = await lstat(join(directory, 'pinned')).then(
            () => true,
            (error) => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              return false;
            },
          );
          items.push({ id: retained.id, completedAt: retained.completedAt, pinned });
        }
        const keep = retainedBackups(items);
        for (const item of items)
          if (!keep.has(item.id)) await rm(join(options.root, item.id), { recursive: true });
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        await options.control
          .prepare("UPDATE native_backup_state SET state='failed',checked_at=? WHERE id=1")
          .bind(new Date().toISOString())
          .run();
        throw error;
      }
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
  };
  return {
    run,
    async due() {
      const last = await options.control
        .prepare('SELECT last_success_at FROM native_backup_state WHERE id=1')
        .first<string>('last_success_at');
      if (!last || Date.now() - Date.parse(last) >= 86_400_000) await run();
    },
    async status() {
      const state = await options.control
        .prepare('SELECT state,checked_at,last_success_at FROM native_backup_state WHERE id=1')
        .first<{
          state: 'never' | 'running' | 'succeeded' | 'failed';
          checked_at: string | null;
          last_success_at: string | null;
        }>();
      if (!state) throw new Error('BACKUP_STATE_UNAVAILABLE');
      return {
        engine: 'sqlite' as const,
        offVolume: root.dev !== (await stat(options.workspacePath)).dev,
        backup: {
          state: state.state,
          checkedAt: state.checked_at,
          lastSucceededAt: state.last_success_at,
        },
      };
    },
    async stop() {
      await running;
    },
  };
}
