import { z } from 'zod';
import { checksumDocument } from '../../site-kit/canonicalize';
import { MAX_DISPATCH_ATTEMPTS } from './dispatch';
import { currentPromotion } from './promotion';
import { publicationJson } from './build-proof';
import { publicationDestination } from './destinations';

const TerminalRunSchema = z.object({
  purpose: z.enum(['verification', 'rollback']).optional(),
  target: z.enum(['staging', 'production']),
  run_id: z.string().regex(/^[1-9][0-9]{0,19}$/),
  run_attempt: z.string().regex(/^[1-9][0-9]{0,19}$/),
  dispatch_revision: z.string().regex(/^[a-f0-9]{40}$/),
  workflow_revision: z.string().regex(/^[a-f0-9]{40}$/),
});

/** Read native execution, never infer completion from elapsed time or a single finished job. */
export async function verifyTerminalRun(
  value: unknown,
  fetcher: typeof fetch,
  githubToken?: string,
  builderOrigin?: string,
) {
  try {
    const input = TerminalRunSchema.parse(value);
    const destination = publicationDestination(input.target, builderOrigin);
    const repository = `PointCommunity/${destination.repository}`;
    const caller =
      input.purpose === 'verification'
        ? 'verify-publication'
        : input.purpose === 'rollback'
          ? 'rollback-production'
          : 'publish-candidate';
    const url = `https://api.github.com/repos/${repository}/actions/runs/${input.run_id}`;
    const read = async (path: string) => {
      const response = await fetcher(path, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'PointSite-Builder',
          'cache-control': 'no-cache',
          ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Unconfirmed native run');
      return publicationJson(response, 32_768);
    };
    const run = z.object({
      id: z
        .number()
        .int()
        .refine((id) => String(id) === input.run_id),
      run_attempt: z.number().int().positive(),
      status: z.literal('completed'),
      conclusion: z.string().min(1),
      head_sha: z.literal(input.dispatch_revision),
      head_branch: z.literal('main'),
      event: z.literal('repository_dispatch'),
      path: z.enum([
        `.github/workflows/${caller}.yml`,
        `.github/workflows/${caller}.yml@main`,
        `.github/workflows/${caller}.yml@refs/heads/main`,
      ]),
      repository: z.object({
        id: z
          .number()
          .int()
          .refine((id) => String(id) === destination.id),
        full_name: z.literal(repository),
      }),
      referenced_workflows: z
        .array(
          z.object({
            path: z.literal(
              `PointCommunity/pointsite-staging/.github/workflows/${input.purpose === 'verification' ? 'verify-runtime' : input.purpose === 'rollback' ? 'rollback-runtime' : input.target === 'staging' ? 'publish-runtime' : 'publish-production-runtime'}.yml@${input.workflow_revision}`,
            ),
            sha: z.literal(input.workflow_revision),
          }),
        )
        .length(1),
    });
    const attempt = run.parse(await read(`${url}/attempts/${input.run_attempt}`));
    if (String(attempt.run_attempt) !== input.run_attempt) throw new Error('Different attempt');
    const latest = run.parse(await read(url));
    if (latest.run_attempt < attempt.run_attempt) throw new Error('Stale run');
    return input;
  } catch {
    throw new Error('PUBLICATION_RUN_NOT_TERMINAL');
  }
}

export const QueuedRecoverySchema = z.strictObject({
  jobId: z.uuid(),
  action: z.enum(['retry', 'cancel', 'reconcile', 'retry-captured', 'verify-completed']),
  expectedAttempts: z.number().int().min(0).max(MAX_DISPATCH_ATTEMPTS),
  actor: z.string().regex(/^github:[1-9][0-9]*$/),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,100}$/),
  requestId: z.string().min(1).max(200),
});
export type QueuedRecoveryInput = z.infer<typeof QueuedRecoverySchema>;

/** A stopped run may retain a confirmed Git commit, but must never have authorized deployment. */
export async function recoverQueuedPublication(
  database: D1Database,
  value: z.infer<typeof QueuedRecoverySchema>,
  fetcher: typeof fetch = fetch,
  builderOrigin?: string,
) {
  const input = QueuedRecoverySchema.parse(value);
  if (input.action === 'retry-captured' || input.action === 'verify-completed')
    throw new Error('PUBLICATION_RECOVERY_CHANGED');
  const requestHash = await checksumDocument({
    jobId: input.jobId,
    action: input.action,
    expectedAttempts: input.expectedAttempts,
    actor: input.actor,
  });
  const authority = database
    .prepare(
      `SELECT j.environment FROM publish_jobs j JOIN user_roles u ON u.email=?
    WHERE j.id=? AND u.active=1 AND ((j.environment='staging' AND u.role IN ('publisher','administrator'))
      OR (j.environment='production-merge' AND u.role='administrator'))`,
    )
    .bind(input.actor, input.jobId);
  if (!(await authority.first())) throw new Error('PUBLISH_AUTHORITY_CHANGED');
  const receipt = async () => {
    const row = await database
      .prepare('SELECT request_hash FROM publication_recovery_receipts WHERE idempotency_key=?')
      .bind(input.idempotencyKey)
      .first<{ request_hash: string }>();
    if (!row) return false;
    if (row.request_hash !== requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
    if (!(await authority.first())) throw new Error('PUBLISH_AUTHORITY_CHANGED');
    return true;
  };
  if (await receipt()) return { recovered: true as const };
  const reserved =
    input.action === 'reconcile'
      ? await database
          .prepare(
            `
    SELECT ps.target,pr.reserved_run_id AS run_id,pr.reserved_run_attempt AS run_attempt,
      pr.dispatch_revision,pi.workflow_revision
    FROM publication_runs pr JOIN publication_inputs pi ON pi.job_id=pr.job_id
    JOIN publication_slots ps ON ps.job_id=pr.job_id JOIN publish_jobs j ON j.id=pr.job_id
    WHERE pr.job_id=? AND pr.reserved_run_id IS NOT NULL AND j.status IN ('queued','running')
      AND pr.deploy_authorized_at IS NULL
  `,
          )
          .bind(input.jobId)
          .first()
      : null;
  const terminal = reserved
    ? await verifyTerminalRun(reserved, fetcher, undefined, builderOrigin)
    : null;
  try {
    await database.batch([
      database
        .prepare(
          `SELECT json(CASE WHEN EXISTS (
        SELECT 1 FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id
        JOIN publication_slots ps ON ps.job_id=j.id JOIN publication_runs pr ON pr.job_id=j.id
        JOIN user_roles actor ON actor.email=? LEFT JOIN user_roles original ON original.email=j.requested_by
        JOIN drafts d ON d.id=pi.draft_id
        WHERE j.id=?
          AND ((?!='reconcile' AND j.status='queued' AND j.result_sha IS NULL AND pr.run_id IS NULL AND pr.reserved_run_id IS NULL) OR
            (j.status IN ('queued','running') AND pr.reserved_run_id=? AND pr.reserved_run_attempt=?
              AND pr.deploy_authorized_at IS NULL))
          AND pr.dispatch_count=? AND actor.active=1
          AND ((ps.target='staging' AND j.environment='staging' AND actor.role IN ('publisher','administrator'))
            OR (ps.target='production' AND j.environment='production-merge' AND actor.role='administrator'))
          AND (?!='retry' OR (d.status='active' AND original.active=1
            AND pr.dispatch_count=${MAX_DISPATCH_ATTEMPTS} AND pr.dispatch_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            AND ((ps.target='staging' AND original.role IN ('publisher','administrator'))
              OR (ps.target='production' AND original.role='administrator' AND ${currentPromotion}))))
      ) THEN 'true' ELSE 'publication recovery changed' END)`,
        )
        .bind(
          input.actor,
          input.jobId,
          input.action,
          terminal?.run_id ?? null,
          terminal?.run_attempt ?? null,
          input.expectedAttempts,
          input.action,
        ),
      database
        .prepare(
          `INSERT INTO publication_recovery_receipts(idempotency_key,job_id,action,request_hash) VALUES (?,?,?,?)`,
        )
        .bind(
          input.idempotencyKey,
          input.jobId,
          input.action === 'retry' ? 'retry' : 'cancel',
          requestHash,
        ),
      ...(input.action === 'retry'
        ? [
            database
              .prepare(
                `UPDATE publication_runs SET dispatch_count=0,
        dispatch_after=strftime('%Y-%m-%dT%H:%M:%fZ','now'),dispatch_error=NULL WHERE job_id=?`,
              )
              .bind(input.jobId),
          ]
        : [
            database
              .prepare(
                `UPDATE publish_jobs SET status='cancelled',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          evidence_json=json_set(evidence_json,'$.failureCode','PUBLICATION_CANCELLED') WHERE id=?`,
              )
              .bind(input.jobId),
            database.prepare('DELETE FROM publication_slots WHERE job_id=?').bind(input.jobId),
          ]),
      database
        .prepare(
          `INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
        VALUES (?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?,'publish-job',?,'succeeded',?,'{}')`,
        )
        .bind(
          crypto.randomUUID(),
          input.actor,
          `publish.${input.action}-requested`,
          input.jobId,
          input.requestId,
        ),
    ]);
  } catch {
    if (await receipt()) return { recovered: true as const };
    throw new Error('PUBLICATION_RECOVERY_CHANGED');
  }
  return { recovered: true as const };
}
