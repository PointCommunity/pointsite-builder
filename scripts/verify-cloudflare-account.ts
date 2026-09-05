import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const POINTSITE_CLOUDFLARE_EMAIL = 'connect@pointaustin.org';
export const POINTSITE_CLOUDFLARE_ACCOUNT_ID = 'bc890091d86ddf9ce669e96e79d47746';

type WranglerIdentity = {
  loggedIn?: unknown;
  email?: unknown;
  accounts?: unknown;
};

export function validatePointSiteCloudflareIdentity(value: unknown): {
  accountId: string;
  email: string;
} {
  if (!value || typeof value !== 'object') {
    throw new Error('Wrangler returned an invalid response; refusing PointSite Cloudflare access.');
  }

  const identity = value as WranglerIdentity;
  if (identity.loggedIn !== true) {
    throw new Error('Wrangler is not authenticated; refusing PointSite Cloudflare access.');
  }

  const hasExpectedAccount =
    Array.isArray(identity.accounts) &&
    (identity.accounts as unknown[]).some((account: unknown) => {
      if (account === null || typeof account !== 'object') return false;
      return (account as Record<string, unknown>).id === POINTSITE_CLOUDFLARE_ACCOUNT_ID;
    });

  if (identity.email !== POINTSITE_CLOUDFLARE_EMAIL || !hasExpectedAccount) {
    throw new Error(
      `PointSite Cloudflare account mismatch. Expected ${POINTSITE_CLOUDFLARE_EMAIL} / ${POINTSITE_CLOUDFLARE_ACCOUNT_ID}; refusing to continue.`,
    );
  }

  return {
    accountId: POINTSITE_CLOUDFLARE_ACCOUNT_ID,
    email: POINTSITE_CLOUDFLARE_EMAIL,
  };
}

async function main(): Promise<void> {
  const run = promisify(execFile);
  const { stdout } = await run('npx', ['wrangler', 'whoami', '--json'], {
    maxBuffer: 1024 * 1024,
  });
  const identity = validatePointSiteCloudflareIdentity(JSON.parse(stdout) as unknown);
  process.stdout.write(
    `Verified PointSite Cloudflare account ${identity.email} / ${identity.accountId}.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
