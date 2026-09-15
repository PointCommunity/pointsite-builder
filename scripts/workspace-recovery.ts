import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { operatorDatabase } from './lib/d1-operator';
import { z } from 'zod';
import {
  D1WorkspaceRecovery,
  RecoveryBookmarkSchema,
} from '../src/server/maintenance/workspace-recovery';
import { D1DeletionReceipts } from '../src/server/maintenance/deletion-receipts';
import { quarantineWorkspace } from '../src/server/maintenance/recovery-control';

// Infrastructure incident tooling. Runtime editorial and publication recovery stay inside Builder.
const account = 'bc890091d86ddf9ce669e96e79d47746';
const workspaceId = 'd4f44410-3f61-47bd-976a-5595973fa6f1';
const recoveryId = '03e12b2e-54ce-4262-a7c3-cf735b341c21';
const runCommand = promisify(execFile);
const { values } = parseArgs({
  options: {
    action: { type: 'string' },
    epoch: { type: 'string' },
    id: { type: 'string' },
    bookmark: { type: 'string' },
    'credential-ref': { type: 'string' },
    'allow-restore': { type: 'boolean' },
  },
});
const action = z
  .enum(['status', 'quarantine', 'settle', 'prepare', 'restore', 'replay', 'reopen'])
  .parse(values.action);
const credential = z.string().startsWith('op://').parse(values['credential-ref']);
const epoch =
  action === 'status' ? undefined : z.coerce.number().int().positive().parse(values.epoch);
const id = action === 'status' ? undefined : z.uuid().parse(values.id);
if (action === 'restore' && !values['allow-restore'])
  throw new Error('Explicit incident approval and --allow-restore required');
if (action === 'prepare') RecoveryBookmarkSchema.parse(values.bookmark);

try {
  const { stdout: revision } = await runCommand('git', ['rev-parse', 'HEAD']);
  const { stdout: dirty } = await runCommand('git', ['status', '--porcelain']);
  if (dirty.trim()) throw new Error('RECOVERY_SOURCE_NOT_CLEAN');
  const healthResponse = await fetch('https://builder.pointatx.org/api/health', {
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  const health = z
    .object({
      sourceRevision: z.literal(revision.trim()),
      sourceClean: z.literal(true),
      workerVersionId: z.string().min(1),
    })
    .safeParse(await healthResponse.json());
  if (!healthResponse.ok || !health.success) throw new Error('RECOVERY_SOURCE_NOT_DEPLOYED');
  // Native 1Password CLI; the token exists only in this process and its Wrangler child environment.
  const { stdout } = await runCommand('op', ['read', credential], { maxBuffer: 16384 });
  process.env.CLOUDFLARE_API_TOKEN = stdout.trim();
  const provider = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60000),
      },
    );
    const data = z
      .object({ success: z.boolean(), result: z.unknown().optional() })
      .parse(await response.json());
    if (!response.ok || data.success !== true)
      throw new Error(`RECOVERY_PROVIDER_HTTP_${response.status}`);
    return data.result;
  };
  // Verify both exact native resources before issuing workspace queries.
  for (const [databaseId, name] of [
    [workspaceId, 'pointsite-builder'],
    [recoveryId, 'pointsite-builder-recovery'],
  ]) {
    z.object({
      uuid: z.literal(databaseId),
      name: z.literal(name),
      version: z.literal('production'),
    }).parse(await provider(`d1/database/${databaseId}`));
  }
  const DB = operatorDatabase((sql) =>
    provider(`d1/database/${workspaceId}/query`, 'POST', { sql }),
  );
  const RECOVERY_DB = operatorDatabase((sql) =>
    provider(`d1/database/${recoveryId}/query`, 'POST', { sql }),
  );
  const recovery = new D1WorkspaceRecovery(DB, RECOVERY_DB);
  const receipts = new D1DeletionReceipts(DB, RECOVERY_DB);
  let result: unknown;
  if (action === 'status') {
    result = await RECOVERY_DB.prepare(
      `SELECT s.epoch,s.mode,s.leased_until,s.recovery_id,r.phase,
      r.target_bookmark,r.previous_bookmark,r.restored_previous_bookmark,r.receipt_cursor FROM workspace_recovery s
      LEFT JOIN workspace_recovery_runs r ON r.id=s.recovery_id WHERE s.id=1`,
    ).first();
  } else if (action === 'quarantine') {
    result = await quarantineWorkspace(RECOVERY_DB, epoch!, id!);
  } else if (action === 'settle') {
    result = await receipts.settlePending(epoch!, id!);
  } else if (action === 'prepare') {
    const saved = await RECOVERY_DB.prepare(
      'SELECT previous_bookmark FROM workspace_recovery_runs WHERE id=? AND epoch=?',
    )
      .bind(id!, epoch!)
      .first<string>('previous_bookmark');
    const previous =
      saved ??
      z
        .object({ bookmark: RecoveryBookmarkSchema })
        .parse(await provider(`d1/database/${workspaceId}/time_travel/bookmark`)).bookmark;
    await recovery.prepare(epoch!, id!, values.bookmark!, previous);
    result = { prepared: true, previousBookmark: previous };
  } else if (action === 'restore') {
    await recovery.restore(epoch!, id!, async (bookmark) =>
      z
        .object({ bookmark: RecoveryBookmarkSchema, previous_bookmark: RecoveryBookmarkSchema })
        .parse(
          await provider(
            `d1/database/${workspaceId}/time_travel/restore?bookmark=${encodeURIComponent(bookmark)}`,
            'POST',
          ),
        ),
    );
    result = { restored: true, access: 'quarantined' };
  } else if (action === 'replay') {
    result = await recovery.replayNext(epoch!, id!);
  } else {
    await recovery.reopen(epoch!, id!);
    result = { reopened: true, epoch: epoch! + 1 };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // Provider exceptions can contain SQL or credentials. Durable status determines the next action.
  const code =
    error instanceof Error && /^[A-Z][A-Z_0-9]+$/.test(error.message)
      ? error.message
      : 'RECOVERY_STOPPED';
  process.stderr.write(
    `${code}. Access was not automatically reopened. Read durable status and the recovery runbook.\n`,
  );
  process.exitCode = 1;
} finally {
  delete process.env.CLOUDFLARE_API_TOKEN;
}
