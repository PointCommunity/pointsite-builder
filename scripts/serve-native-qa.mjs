import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const port = Number(process.env.NATIVE_QA_PORT ?? 4183);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_QA_PORT');
const directory = await mkdtemp(join(tmpdir(), 'builder-native-browser-'));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/server/index.js'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    ENVIRONMENT: 'local',
    APP_VERSION: 'native-browser-qa',
    BUILDER_ORIGIN: origin,
    STAGING_REPOSITORY: 'PointCommunity/pointsite-staging',
    PRODUCTION_ENABLED: 'false',
    DEV_AUTH_EMAIL: 'native-qa@example.com',
    DRAFT_STORAGE_FORMAT: 'compact-v1',
    PORT: String(port),
    DATA_DIRECTORY: join(directory, 'workspace'),
    RECOVERY_DIRECTORY: join(directory, 'recovery'),
  },
});
const exited = new Promise((resolve) => {
  child.once('exit', resolve);
  child.once('error', resolve);
});
child.stderr.resume();
try {
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('NATIVE_QA_STARTUP_TIMEOUT')), 15_000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('builder_listening')) {
        clearTimeout(deadline);
        resolve();
      }
    });
    child.once('exit', () => {
      clearTimeout(deadline);
      reject(new Error('NATIVE_QA_STARTUP_FAILED'));
    });
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
  });
  const database = new DatabaseSync(join(directory, 'workspace/workspace.sqlite'));
  try {
    database
      .prepare(
        "INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by) VALUES ('native-qa@example.com','administrator',1,'fixture','fixture','fixture')",
      )
      .run();
  } finally {
    database.close();
  }
  console.log(JSON.stringify({ event: 'native_qa_ready', origin, directory, pid: child.pid }));
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
    child.once('exit', resolve);
  });
} finally {
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
  await exited;
  clearTimeout(deadline);
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ event: 'native_qa_cleaned' }));
}
