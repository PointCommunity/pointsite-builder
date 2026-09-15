import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { getPlatformProxy, unstable_readConfig } from 'wrangler';
import { z } from 'zod';
import { D1StorageCompaction } from '../src/server/maintenance/storage-compaction';
import {
  POINTSITE_CLOUDFLARE_ACCOUNT_ID,
  validatePointSiteCloudflareIdentity,
} from './verify-cloudflare-account';

const databaseId = 'd4f44410-3f61-47bd-976a-5595973fa6f1';
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const deploymentSchema = z
  .array(
    z.object({
      id: z.uuid(),
      created_on: z.iso.datetime({ offset: true }),
      versions: z
        .array(z.object({ version_id: z.uuid(), percentage: z.number().min(0).max(100) }))
        .min(1),
    }),
  )
  .min(1);
const healthSchema = z.object({
  ok: z.literal(true),
  environment: z.literal('production'),
  sourceRevision: sha,
  sourceClean: z.literal(true),
  workerVersionId: z.uuid(),
  storageReaders: z.array(z.string()),
  storageWriteFormat: z.enum(['legacy', 'compact-v1']),
});

export function compactionMode(args: string[]) {
  if (args.length === 1 && args[0] === '--status') return { mode: 'status' as const };
  if (
    args.length === 2 &&
    ['--verify-reader', '--apply'].includes(args[0]) &&
    sha.safeParse(args[1]).success
  )
    return {
      mode: args[0] === '--apply' ? ('apply' as const) : ('verify-reader' as const),
      sourceRevision: args[1],
    };
  throw new Error('STORAGE_COMPACTION_ARGUMENTS');
}

export function verifyReaderDeployment(
  deployments: unknown,
  health: unknown,
  expectedSource: string,
  compactWriter = false,
) {
  const parsedDeployments = deploymentSchema.safeParse(deployments);
  const parsedHealth = healthSchema.safeParse(health);
  if (!parsedDeployments.success || !parsedHealth.success || !sha.safeParse(expectedSource).success)
    throw new Error('STORAGE_READER_UNVERIFIED');
  const ordered = parsedDeployments.data.sort(
    (a, b) => Date.parse(a.created_on) - Date.parse(b.created_on),
  );
  const latest = ordered.at(-1)!;
  const active = latest.versions.filter((version) => version.percentage > 0);
  const observed = parsedHealth.data;
  if (
    (ordered.length > 1 &&
      Date.parse(ordered.at(-2)!.created_on) === Date.parse(latest.created_on)) ||
    active.length !== 1 ||
    active[0].percentage !== 100 ||
    active[0].version_id !== observed.workerVersionId ||
    observed.sourceRevision !== expectedSource ||
    !['legacy', 'compact-v1'].every((format) => observed.storageReaders.includes(format)) ||
    (compactWriter && observed.storageWriteFormat !== 'compact-v1')
  )
    throw new Error('STORAGE_READER_UNVERIFIED');
  return {
    deploymentId: latest.id,
    versionId: active[0].version_id,
    sourceRevision: observed.sourceRevision,
    storageWriteFormat: observed.storageWriteFormat,
  };
}

export function verifyReaderDatabase(metadata: unknown, versionId: string) {
  const parsed = z
    .object({
      id: z.uuid(),
      resources: z.object({
        bindings: z.array(
          z.object({ name: z.string(), type: z.string(), id: z.string().optional() }),
        ),
      }),
    })
    .safeParse(metadata);
  if (!parsed.success || parsed.data.id !== versionId) throw new Error('STORAGE_READER_DATABASE');
  const bindings = parsed.data.resources.bindings.filter((binding) => binding.name === 'DB');
  if (bindings.length !== 1 || bindings[0].type !== 'd1' || bindings[0].id !== databaseId)
    throw new Error('STORAGE_READER_DATABASE');
}

type ReaderProof = ReturnType<typeof verifyReaderDeployment>;
type Compaction = Pick<D1StorageCompaction, 'status' | 'step'>;
export async function runCompaction(
  mode: 'status' | 'apply',
  compaction: Compaction,
  verify: () => Promise<ReaderProof>,
  report: (
    event: Awaited<ReturnType<Compaction['status']>> | { state: 'running'; processed: number },
  ) => void,
) {
  const status = await compaction.status();
  report(status);
  if (mode === 'status') return;
  const reader = await verify();
  if (status.state === 'complete') return;
  let processed = 0;
  for (let steps = 0; steps < 10_000; steps += 8) {
    let complete = false;
    for (let batch = 0; batch < 8; batch++) {
      const result = await compaction.step('storage-compaction-cli', crypto.randomUUID());
      if (!result.processed) {
        complete = true;
        break;
      }
      processed++;
    }
    if (JSON.stringify(await verify()) !== JSON.stringify(reader))
      throw new Error('STORAGE_READER_CHANGED');
    if (complete) {
      const final = await compaction.status();
      report(final);
      if (final.state !== 'complete') throw new Error('STORAGE_COMPACTION_CHANGED');
      return;
    }
    // Report confirmed steps; recounting all remaining rows after each batch grows quadratically.
    report({ state: 'running', processed });
  }
  throw new Error('STORAGE_COMPACTION_STEP_LIMIT');
}

async function main() {
  const mode = compactionMode(process.argv.slice(2));
  const configPath = resolve('wrangler.jsonc');
  const config = z
    .object({
      name: z.literal('pointsite-builder'),
      account_id: z.literal(POINTSITE_CLOUDFLARE_ACCOUNT_ID),
      compatibility_date: z.string(),
      vars: z.object({
        ENVIRONMENT: z.literal('production'),
        BUILDER_ORIGIN: z.literal('https://builder.pointatx.org'),
      }),
      d1_databases: z.array(
        z.object({ binding: z.string(), database_name: z.string(), database_id: z.uuid() }),
      ),
    })
    .parse(unstable_readConfig({ config: configPath }, { hideWarnings: true }));
  const database = config.d1_databases.find((entry) => entry.binding === 'DB');
  if (database?.database_name !== 'pointsite-builder' || database.database_id !== databaseId)
    throw new Error('STORAGE_COMPACTION_TARGET');
  const run = promisify(execFile);
  const wrangler = async (args: string[]): Promise<unknown> => {
    // Capture output in memory. Never forward provider errors, credentials or bindings to logs.
    const { stdout } = await run(
      process.execPath,
      [resolve('node_modules/wrangler/bin/wrangler.js'), ...args, '--json'],
      { maxBuffer: 1024 * 1024, timeout: 60_000 },
    );
    return JSON.parse(stdout) as unknown;
  };
  validatePointSiteCloudflareIdentity(await wrangler(['whoami']));
  const verify = async () => {
    if (!mode.sourceRevision) throw new Error('STORAGE_COMPACTION_ARGUMENTS');
    const args = ['deployments', 'list', '--config', configPath];
    const before = await wrangler(args);
    const response = await fetch(new URL('/api/health', config.vars.BUILDER_ORIGIN), {
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || response.headers.get('cache-control') !== 'no-store')
      throw new Error('STORAGE_READER_UNVERIFIED');
    const health: unknown = await response.json();
    const proof = verifyReaderDeployment(
      before,
      health,
      mode.sourceRevision,
      mode.mode === 'apply',
    );
    verifyReaderDatabase(
      await wrangler(['versions', 'view', proof.versionId, '--config', configPath]),
      proof.versionId,
    );
    const after = verifyReaderDeployment(
      await wrangler(args),
      health,
      mode.sourceRevision,
      mode.mode === 'apply',
    );
    if (proof.deploymentId !== after.deploymentId) throw new Error('STORAGE_READER_CHANGED');
    return proof;
  };
  if (mode.mode === 'verify-reader') {
    console.log(JSON.stringify({ verified: true, ...(await verify()) }));
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'pointsite-storage-compaction-'));
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined;
  try {
    const remoteConfig = join(directory, 'wrangler.json');
    await writeFile(
      remoteConfig,
      JSON.stringify({
        name: 'pointsite-builder-storage-compaction',
        account_id: config.account_id,
        compatibility_date: config.compatibility_date,
        d1_databases: [{ ...database, remote: true }],
      }),
      { mode: 0o600 },
    );
    platform = await getPlatformProxy<{ DB: D1Database }>({
      configPath: remoteConfig,
      persist: false,
      remoteBindings: true,
      envFiles: [],
    });
    await runCompaction(mode.mode, new D1StorageCompaction(platform.env.DB), verify, (status) =>
      console.log(JSON.stringify(status)),
    );
  } finally {
    try {
      await platform?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    const code =
      message.match(
        /STORAGE_[A-Z_]+|ASSET_MIGRATION_[A-Z_]+|REVISION_[A-Z_]+|RECEIPT_[A-Z_]+/,
      )?.[0] ?? 'STORAGE_COMPACTION_FAILED';
    const detail =
      process.argv[2] === '--apply'
        ? 'Conversion stopped; completed atomic steps remain recorded. Verify deployment before resuming.'
        : 'Read-only check failed; no conversion was requested.';
    console.error(`${code}: ${detail}`);
    process.exitCode = 1;
  });
