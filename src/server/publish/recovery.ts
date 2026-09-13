import { z } from 'zod';
import { checksumDocument } from '../../site-kit/canonicalize';
import { MAX_DISPATCH_ATTEMPTS } from './dispatch';
import { currentPromotion } from './promotion';

export const QueuedRecoverySchema = z.strictObject({
  jobId: z.uuid(),
  action: z.enum(['retry', 'cancel']),
  expectedAttempts: z.number().int().min(0).max(MAX_DISPATCH_ATTEMPTS),
  actor: z.string().regex(/^github:[1-9][0-9]*$/),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,100}$/),
  requestId: z.string().min(1).max(200),
});
export type QueuedRecoveryInput = z.infer<typeof QueuedRecoverySchema>;

/** Only an unreserved job can be fenced without waiting for native execution to stop. */
export async function recoverQueuedPublication(
  database: D1Database,
  value: z.infer<typeof QueuedRecoverySchema>,
) {
  const input = QueuedRecoverySchema.parse(value);
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
  try {
    await database.batch([
      database
        .prepare(
          `SELECT json(CASE WHEN EXISTS (
        SELECT 1 FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id
        JOIN publication_slots ps ON ps.job_id=j.id JOIN publication_runs pr ON pr.job_id=j.id
        JOIN user_roles actor ON actor.email=? LEFT JOIN user_roles original ON original.email=j.requested_by
        JOIN drafts d ON d.id=pi.draft_id
        WHERE j.id=? AND j.status='queued' AND j.result_sha IS NULL AND pr.run_id IS NULL
          AND pr.reserved_run_id IS NULL AND pr.dispatch_count=? AND actor.active=1
          AND ((ps.target='staging' AND j.environment='staging' AND actor.role IN ('publisher','administrator'))
            OR (ps.target='production' AND j.environment='production-merge' AND actor.role='administrator'))
          AND (?='cancel' OR (d.status='active' AND original.active=1
            AND pr.dispatch_count=${MAX_DISPATCH_ATTEMPTS} AND pr.dispatch_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            AND ((ps.target='staging' AND original.role IN ('publisher','administrator'))
              OR (ps.target='production' AND original.role='administrator' AND ${currentPromotion}))))
      ) THEN 'true' ELSE 'publication recovery changed' END)`,
        )
        .bind(input.actor, input.jobId, input.expectedAttempts, input.action),
      database
        .prepare(
          `INSERT INTO publication_recovery_receipts(idempotency_key,job_id,action,request_hash) VALUES (?,?,?,?)`,
        )
        .bind(input.idempotencyKey, input.jobId, input.action, requestHash),
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
