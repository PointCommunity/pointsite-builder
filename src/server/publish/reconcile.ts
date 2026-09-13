import { z } from 'zod';
import { checksumDocument } from '../../site-kit/canonicalize';
import { PublicationBuildSchema } from './build-proof';
import { verifyDeploymentProof } from './deployment-proof';
import { QueuedRecoverySchema, verifyTerminalRun, type QueuedRecoveryInput } from './recovery';
import { verifiedReleaseStatement } from './releases';

/** Record an already completed deployment. This path never authorizes or performs publication. */
export async function reconcileCompletedPublication(
  database: D1Database,
  value: QueuedRecoveryInput,
  fetcher: typeof fetch = fetch,
) {
  const input = QueuedRecoverySchema.parse(value);
  if (input.action !== 'verify-completed') throw new Error('PUBLICATION_RECOVERY_CHANGED');
  const requestHash = await checksumDocument({
    jobId: input.jobId,
    action: input.action,
    expectedAttempts: input.expectedAttempts,
    actor: input.actor,
  });
  const role = `u.active=1 AND ((j.environment='staging' AND u.role IN ('publisher','administrator'))
    OR (j.environment='production-merge' AND u.role='administrator'))`;
  const authority = database
    .prepare(`SELECT 1 FROM user_roles u JOIN publish_jobs j ON j.id=? WHERE u.email=? AND ${role}`)
    .bind(input.jobId, input.actor);
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
  const source = await database
    .prepare(
      `SELECT j.environment,j.candidate_checksum,j.result_sha,
    pr.run_id,pr.run_attempt,pr.check_run_id,pr.dispatch_revision,pi.workflow_revision,pr.build_json,pr.deployment_json
    FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id
    JOIN publication_runs pr ON pr.job_id=j.id JOIN publication_slots ps ON ps.job_id=j.id
    WHERE j.id=? AND j.status='running' AND pr.dispatch_count=?
      AND pr.commit_authorized_at IS NOT NULL AND pr.deploy_authorized_at IS NOT NULL
      AND pr.deployment_json IS NOT NULL AND pr.run_id=pr.reserved_run_id AND pr.run_attempt=pr.reserved_run_attempt
      AND ((j.environment='staging' AND ps.target='staging') OR (j.environment='production-merge' AND ps.target='production'))`,
    )
    .bind(input.jobId, input.expectedAttempts)
    .first<{
      environment: string;
      candidate_checksum: string;
      result_sha: string;
      run_id: string;
      run_attempt: string;
      check_run_id: string;
      dispatch_revision: string;
      workflow_revision: string;
      build_json: string;
      deployment_json: string;
    }>();
  if (!source) throw new Error('PUBLICATION_RECOVERY_CHANGED');
  const target = source.environment === 'staging' ? 'staging' : 'production';
  const build = PublicationBuildSchema.parse(JSON.parse(source.build_json));
  const deployment = (
    target === 'staging'
      ? z.strictObject({ workerVersionId: z.uuid() })
      : z.strictObject({ artifactDigest: z.literal(build.artifactDigest) })
  ).parse(JSON.parse(source.deployment_json));
  if (
    source.result_sha !== build.commitSha ||
    source.candidate_checksum !== build.candidateChecksum
  )
    throw new Error('PUBLICATION_VERIFICATION_UNCONFIRMED');
  await verifyTerminalRun(
    {
      target,
      run_id: source.run_id,
      run_attempt: source.run_attempt,
      dispatch_revision: source.dispatch_revision,
      workflow_revision: source.workflow_revision,
    },
    fetcher,
  );
  const evidence = {
    ...(await verifyDeploymentProof(
      {
        target,
        ...deployment,
        runId: source.run_id,
        checkRunId: source.check_run_id,
        dispatchRevision: source.dispatch_revision,
        workflowRevision: source.workflow_revision,
        commitSha: build.commitSha,
        candidateChecksum: build.candidateChecksum,
        artifactDigest: build.artifactDigest,
      },
      fetcher,
    )),
    verificationStatus: 'passed',
  };
  try {
    await database.batch([
      database
        .prepare(
          `SELECT json(CASE WHEN EXISTS (
        SELECT 1 FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id
        JOIN publication_runs pr ON pr.job_id=j.id JOIN publication_slots ps ON ps.job_id=j.id
        JOIN user_roles u ON u.email=? WHERE j.id=? AND j.status='running' AND ${role}
          AND ps.target=? AND pr.dispatch_count=? AND pr.run_id=? AND pr.run_attempt=? AND pr.check_run_id=?
          AND pr.dispatch_revision=? AND pi.workflow_revision=? AND pr.build_json=? AND pr.deployment_json=?
          AND pr.commit_authorized_at IS NOT NULL AND pr.deploy_authorized_at IS NOT NULL AND j.result_sha=?
        ) THEN 'true' ELSE 'publication recovery changed' END)`,
        )
        .bind(
          input.actor,
          input.jobId,
          target,
          input.expectedAttempts,
          source.run_id,
          source.run_attempt,
          source.check_run_id,
          source.dispatch_revision,
          source.workflow_revision,
          source.build_json,
          source.deployment_json,
          build.commitSha,
        ),
      // Retry the missing completion receipt, never the deployment operation.
      database
        .prepare(
          "INSERT INTO publication_recovery_receipts(idempotency_key,job_id,action,request_hash) VALUES (?,?,'retry',?)",
        )
        .bind(input.idempotencyKey, input.jobId, requestHash),
      database
        .prepare(
          `UPDATE publish_jobs SET status='succeeded',evidence_json=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        )
        .bind(JSON.stringify(evidence), input.jobId),
      verifiedReleaseStatement(database, input.jobId),
      database
        .prepare("DELETE FROM publication_slots WHERE target='production' AND job_id=?")
        .bind(input.jobId),
      database
        .prepare(
          `INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
        VALUES (?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,'publish.deployment-reconciled','publish-job',?,'succeeded',?,'{}')`,
        )
        .bind(crypto.randomUUID(), input.actor, input.jobId, input.requestId),
    ]);
  } catch {
    if (await receipt()) return { recovered: true as const };
    throw new Error('PUBLICATION_RECOVERY_CHANGED');
  }
  return { recovered: true as const };
}
