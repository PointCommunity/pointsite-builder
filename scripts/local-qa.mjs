import { access, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const markerName = '.pipeliner-local-qa.json';
const generatedPaths = [
  'node_modules',
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
  'artifacts',
  '.wrangler',
];

async function absent(file) {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function requireFreePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid QA port');
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

export async function prepare(directory, port = Number(process.env.PLAYWRIGHT_PORT ?? 4173)) {
  const root = await realpath(directory);
  await requireFreePort(port);
  const createdPaths = [];
  for (const relative of generatedPaths)
    if (await absent(path.join(root, relative))) createdPaths.push(relative);
  await writeFile(
    path.join(root, markerName),
    JSON.stringify({ version: 1, root, run: randomUUID(), port, createdPaths }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return createdPaths;
}

export async function cleanup(directory) {
  const root = await realpath(directory);
  const markerPath = path.join(root, markerName);
  if ((await lstat(markerPath)).isSymbolicLink()) throw new Error('unsafe QA inventory');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  if (
    marker.version !== 1 ||
    marker.root !== root ||
    typeof marker.run !== 'string' ||
    !marker.run ||
    !Array.isArray(marker.createdPaths) ||
    new Set(marker.createdPaths).size !== marker.createdPaths.length ||
    marker.createdPaths.some((relative) => !generatedPaths.includes(relative))
  )
    throw new Error('invalid QA inventory');
  // Do not stop arbitrary processes. The test harness must release its server first.
  await requireFreePort(marker.port);
  for (const relative of marker.createdPaths) {
    const target = path.join(root, relative);
    if (await absent(target)) continue;
    if ((await lstat(target)).isSymbolicLink())
      throw new Error(`refusing QA output symlink: ${relative}`);
    await rm(target, { recursive: true });
    if (!(await absent(target))) throw new Error(`QA cleanup failed: ${relative}`);
  }
  await rm(markerPath);
  await access(root);
  return marker.createdPaths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const command = process.argv[2];
  if (!['prepare', 'cleanup'].includes(command))
    throw new Error('Usage: node scripts/local-qa.mjs prepare|cleanup');
  const paths = await (command === 'prepare' ? prepare(process.cwd()) : cleanup(process.cwd()));
  console.log(`Local QA ${command} verified for ${paths.length} task-owned output paths.`);
}
