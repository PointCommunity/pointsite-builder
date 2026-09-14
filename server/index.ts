import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { parseConfig } from '../src/server/config';
import { openNativeWorkspace } from './workspace';
import { startNativeServer } from './http';
import { startScheduler } from './scheduler';
import { parseFeedbackConfig } from '../src/server/feedback/service';

const Hosting = z.object({
  DATA_DIRECTORY: z.string().startsWith('/'),
  RECOVERY_DIRECTORY: z.string().startsWith('/'),
  BACKUP_DIRECTORY: z.string().startsWith('/').optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_ROOT: z.string().default('dist/client'),
  RELEASE_FILE: z.string().default('dist/release.json'),
});
const Release = z.object({
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  gitTree: z.string().regex(/^[a-f0-9]{40}$/),
  sourceClean: z.boolean(),
});

export async function main() {
  const config = parseConfig({ ...process.env, RUNTIME: 'node' });
  const hosting = Hosting.parse(process.env);
  const release = Release.parse(JSON.parse(await readFile(hosting.RELEASE_FILE, 'utf8')));
  if (config.environment !== 'local' && !release.sourceClean)
    throw new Error('CLEAN_RELEASE_REQUIRED');
  const app = await openNativeWorkspace({
    workspacePath: resolve(hosting.DATA_DIRECTORY, 'workspace.sqlite'),
    recoveryPath: resolve(hosting.RECOVERY_DIRECTORY, 'control.sqlite'),
    backupRoot: hosting.BACKUP_DIRECTORY,
    migrationRoot: process.cwd(),
    publicRoot: resolve(hosting.PUBLIC_ROOT),
    config,
    feedbackConfig: parseFeedbackConfig(process.env),
    release: { ...release, workerVersionId: null, storageWriteFormat: config.draftStorageFormat },
  });
  try {
    const http = await startNativeServer(app.fetch, {
      hostname: config.environment === 'local' ? '127.0.0.1' : '0.0.0.0',
      port: hosting.PORT,
    });
    const scheduler = startScheduler(async () => {
      try {
        await app.runtime.scheduled();
      } finally {
        await app.backups?.due();
      }
    });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await Promise.all([scheduler.stop(), http.stop()]);
      await app.backups?.stop();
      app.close();
    };
    for (const signal of ['SIGTERM', 'SIGINT'])
      process.once(signal, () => {
        void stop().catch(() => {
          console.error('{"event":"shutdown_failed"}');
          process.exitCode = 1;
        });
      });
    console.log(
      JSON.stringify({
        event: 'builder_listening',
        environment: config.environment,
        port: hosting.PORT,
        ...release,
      }),
    );
  } catch (error) {
    app.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error('{"event":"builder_startup_failed"}');
    process.exitCode = 1;
  });
}
