import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPlatformProxy, unstable_readConfig } from 'wrangler';
import { z } from 'zod';
import { D1OwnershipMigration } from '../src/server/maintenance/asset-migration';
import { candidateImagePath } from '../src/server/publish/candidate';

export function migrationMode(args: string[]): 'status' | 'apply' {
  if (args.length !== 1 || !['--status', '--apply'].includes(args[0]))
    throw new Error('Use exactly --status or --apply');
  return args[0] === '--apply' ? 'apply' : 'status';
}

export async function runMigration(
  mode: 'status' | 'apply',
  migration: Pick<D1OwnershipMigration, 'status' | 'step'>,
  report: (status: Awaited<ReturnType<D1OwnershipMigration['status']>>) => void,
) {
  let status = await migration.status();
  report(status);
  if (mode === 'status') return;
  for (let steps = 0; status.state !== 'complete' && steps < 10_000; steps++) {
    status = await migration.step('asset-migration-cli', crypto.randomUUID());
    report(status);
  }
  if (status.state !== 'complete') throw new Error('ASSET_MIGRATION_STEP_LIMIT');
}

async function main() {
  const mode = migrationMode(process.argv.slice(2));
  const config = z
    .object({
      name: z.literal('pointsite-builder'),
      vars: z.object({ ENVIRONMENT: z.literal('production') }),
      compatibility_date: z.string(),
      account_id: z.string().optional(),
      d1_databases: z.array(
        z.object({
          binding: z.string(),
          database_name: z.string().optional(),
          database_id: z.string().optional(),
        }),
      ),
    })
    .parse(unstable_readConfig({ config: resolve('wrangler.jsonc') }, { hideWarnings: true }));
  const database = config.d1_databases.find((binding) => binding.binding === 'DB');
  if (
    config.name !== 'pointsite-builder' ||
    config.vars.ENVIRONMENT !== 'production' ||
    !database ||
    database.database_name !== 'pointsite-builder' ||
    !/^[a-f0-9-]{36}$/.test(database.database_id ?? '')
  )
    throw new Error('ASSET_MIGRATION_TARGET_INVALID');
  const directory = await mkdtemp(join(tmpdir(), 'pointsite-asset-migration-'));
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined;
  try {
    const configPath = join(directory, 'wrangler.json');
    await writeFile(
      configPath,
      JSON.stringify({
        name: 'pointsite-builder-asset-migration',
        compatibility_date: config.compatibility_date,
        ...(config.account_id ? { account_id: config.account_id } : {}),
        d1_databases: [
          {
            binding: 'DB',
            database_name: database.database_name,
            database_id: database.database_id,
            remote: true,
          },
        ],
      }),
    );
    console.log(
      JSON.stringify({
        operation: mode,
        database: database.database_name,
        databaseId: database.database_id,
      }),
    );
    // Wrangler owns authentication and remote proxy lifetime. Never read or print tokens.
    platform = await getPlatformProxy<{ DB: D1Database }>({
      configPath,
      persist: false,
      remoteBindings: true,
      envFiles: [],
    });
    const assets: Pick<Fetcher, 'fetch'> = {
      fetch: (input) => {
        const path = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        ).pathname;
        if (!candidateImagePath.test(path) || path.startsWith('/assets/builder/'))
          return Promise.resolve(new Response(null, { status: 404 }));
        return fetch(new URL(path, 'https://builder.pointatx.org'), { redirect: 'error' });
      },
    };
    await runMigration(mode, new D1OwnershipMigration(platform.env.DB, assets), (status) =>
      console.log(JSON.stringify(status)),
    );
  } finally {
    await platform?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    const code =
      message.match(/ASSET_MIGRATION_[A-Z_]+|MEDIA_STORAGE_CORRUPT|MEDIA_NOT_FOUND/)?.[0] ??
      (message.toLowerCase().includes('capacity')
        ? 'ASSET_MIGRATION_CAPACITY'
        : 'ASSET_MIGRATION_FAILED');
    console.error(`${code}: migration stopped; original storage remains protected while pending.`);
    process.exitCode = 1;
  });
}
