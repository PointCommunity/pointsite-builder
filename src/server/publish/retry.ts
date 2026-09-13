import { checksumDocument } from '../../site-kit/canonicalize';
import { QueuedRecoverySchema, type QueuedRecoveryInput } from './recovery';

/** A new job copies immutable pins; it never reads the editor's current revision. */
export async function retryCapturedStaging(
  database: D1Database,
  value: QueuedRecoveryInput,
  workflowRevision: string,
  verifyBase: (baseSha: string) => Promise<void>,
) {
  const input = QueuedRecoverySchema.parse(value);
  if (input.action !== 'retry-captured') throw new Error('PUBLICATION_RECOVERY_CHANGED');
  const requestHash = await checksumDocument({
    jobId: input.jobId,
    action: input.action,
    expectedAttempts: input.expectedAttempts,
    actor: input.actor,
  });
  const authority = database
    .prepare(
      `SELECT 1 FROM user_roles u JOIN publish_jobs j ON j.id=?
    WHERE u.email=? AND u.active=1 AND u.role IN ('publisher','administrator') AND j.environment='staging'`,
    )
    .bind(input.jobId, input.actor);
  if (!(await authority.first())) throw new Error('PUBLISH_AUTHORITY_CHANGED');
  const receipt = async () => {
    const row = await database
      .prepare(
        `SELECT j.id,r.request_hash,receipt.request_hash AS recovery_hash FROM (SELECT ? AS key) input
      LEFT JOIN publish_jobs j ON j.idempotency_key=input.key
      LEFT JOIN publication_retries r ON r.job_id=j.id
      LEFT JOIN publication_recovery_receipts receipt ON receipt.idempotency_key=input.key`,
      )
      .bind(input.idempotencyKey)
      .first<{ id: string | null; request_hash: string | null; recovery_hash: string | null }>();
    if (!row || (!row.id && !row.recovery_hash)) return null;
    if (!row.id || row.request_hash !== requestHash || row.recovery_hash !== requestHash)
      throw new Error('IDEMPOTENCY_CONFLICT');
    if (!(await authority.first())) throw new Error('PUBLISH_AUTHORITY_CHANGED');
    return { recovered: true as const, jobId: row.id };
  };
  const previous = await receipt();
  if (previous) return previous;
  const source = await database
    .prepare(
      `SELECT COALESCE(j.result_sha,j.base_sha) AS base_sha,COALESCE(r.attempt,0)+1 AS attempt
    FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id
    JOIN publication_runs pr ON pr.job_id=j.id JOIN drafts d ON d.id=pi.draft_id
    LEFT JOIN publication_retries r ON r.job_id=j.id
    WHERE j.id=? AND j.environment='staging' AND j.status='cancelled'
      AND pr.deploy_authorized_at IS NULL AND pr.dispatch_count=? AND d.status='active'
      AND pi.workflow_revision=? AND COALESCE(r.attempt,0)<3
      AND NOT EXISTS(SELECT 1 FROM publication_retries WHERE parent_job_id=j.id)`,
    )
    .bind(input.jobId, input.expectedAttempts, workflowRevision)
    .first<{ base_sha: string; attempt: number }>();
  if (!source) throw new Error('PUBLICATION_RECOVERY_CHANGED');
  await verifyBase(source.base_sha);
  const id = crypto.randomUUID();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  try {
    await database.batch([
      database
        .prepare(
          `SELECT json(CASE WHEN EXISTS (
        SELECT 1 FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id
        JOIN publication_runs pr ON pr.job_id=j.id JOIN drafts d ON d.id=pi.draft_id
        JOIN user_roles u ON u.email=? LEFT JOIN publication_retries r ON r.job_id=j.id
        WHERE j.id=? AND j.environment='staging' AND j.status='cancelled'
          AND pr.deploy_authorized_at IS NULL AND pr.dispatch_count=? AND d.status='active'
          AND pi.workflow_revision=? AND COALESCE(j.result_sha,j.base_sha)=?
          AND COALESCE(r.attempt,0)+1=? AND u.active=1 AND u.role IN ('publisher','administrator')
          AND NOT EXISTS(SELECT 1 FROM publication_retries WHERE parent_job_id=j.id)
        ) AND NOT EXISTS(SELECT 1 FROM publication_slots WHERE target='staging')
          AND NOT EXISTS(SELECT 1 FROM publish_jobs WHERE environment='staging' AND status IN ('queued','running'))
        THEN 'true' ELSE 'publication retry changed' END)`,
        )
        .bind(
          input.actor,
          input.jobId,
          input.expectedAttempts,
          workflowRevision,
          source.base_sha,
          source.attempt,
        ),
      database
        .prepare(
          `INSERT INTO publication_recovery_receipts(idempotency_key,job_id,action,request_hash) VALUES (?,?,'retry',?)`,
        )
        .bind(input.idempotencyKey, input.jobId, requestHash),
      database
        .prepare(
          `INSERT INTO publish_jobs(id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at)
        SELECT ?,?,'staging','queued',candidate_json,candidate_checksum,repository,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM publish_jobs WHERE id=?`,
        )
        .bind(id, input.idempotencyKey, source.base_sha, input.actor, input.jobId),
      database
        .prepare(
          `INSERT INTO publication_inputs(job_id,draft_id,revision_id,workflow_revision)
        SELECT ?,draft_id,revision_id,workflow_revision FROM publication_inputs WHERE job_id=?`,
        )
        .bind(id, input.jobId),
      database
        .prepare(
          `INSERT INTO publication_retries(job_id,parent_job_id,attempt,request_hash) VALUES (?,?,?,?)`,
        )
        .bind(id, input.jobId, source.attempt, requestHash),
      database
        .prepare(
          `INSERT INTO publication_asset_pins(job_id,draft_id,source_path,asset_id)
        SELECT ?,draft_id,source_path,asset_id FROM publication_asset_pins WHERE job_id=?`,
        )
        .bind(id, input.jobId),
      database
        .prepare("INSERT INTO publication_slots(target,job_id) VALUES ('staging',?)")
        .bind(id),
      database
        .prepare('INSERT INTO publication_runs(job_id,nonce,dispatch_revision) VALUES (?,?,?)')
        .bind(id, nonce, source.base_sha),
      database
        .prepare(
          `INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
        VALUES (?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,'publish.captured-retry','publish-job',?,'succeeded',?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.actor,
          id,
          input.requestId,
          JSON.stringify({ parentJobId: input.jobId, attempt: source.attempt }),
        ),
    ]);
  } catch {
    const committed = await receipt();
    if (committed) return committed;
    throw new Error('PUBLICATION_RECOVERY_CHANGED');
  }
  return { recovered: true as const, jobId: id };
}
