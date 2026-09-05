import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const baseUrl = value('--url')?.replace(/\/$/, '');
const exportPath = resolve(value('--export') ?? `artifacts/retention-${Date.now()}.json`);
const apply = args.includes('--apply');
if (!baseUrl)
  throw new Error(
    'Usage: node scripts/maintenance.mjs --url <builder-url> [--export path] [--apply]',
  );

const headers = {
  ...(process.env.CF_ACCESS_CLIENT_ID
    ? { 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID }
    : {}),
  ...(process.env.CF_ACCESS_CLIENT_SECRET
    ? { 'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET }
    : {}),
};
const dryRun = await fetch(`${baseUrl}/api/admin/retention`, { headers });
if (!dryRun.ok) throw new Error(`Retention dry run failed (${dryRun.status})`);
const plan = await dryRun.json();
await mkdir(dirname(exportPath), { recursive: true });
await writeFile(exportPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ dryRun: true, exportPath, report: plan.report })}\n`);

if (apply) {
  const response = await fetch(`${baseUrl}/api/admin/retention/apply`, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ exportChecksum: plan.exportChecksum }),
  });
  if (!response.ok) throw new Error(`Retention apply failed (${response.status})`);
  process.stdout.write(`${JSON.stringify(await response.json())}\n`);
}
