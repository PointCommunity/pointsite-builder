import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { checksumDocument } from '../../site-kit/canonicalize';
import { createPublisherToken, githubHeaders } from '../github/app-auth';
import { PublicationBuildSchema, publicationJson } from './build-proof';
import {
  PublicationEvidenceSchema,
  verifyDeploymentProof,
  verifyStagingDeployment,
} from './deployment-proof';
import { verifiedReleaseStatement } from './releases';
import { verifyTerminalRun } from './recovery';
import { verifyPublicationRunner, type PublicationRunnerScope } from './runner-auth';
import type { PublisherConfig } from './service';
import { MAX_DISPATCH_ATTEMPTS } from './dispatch';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const identifier = z.string().regex(/^[1-9][0-9]{0,19}$/);
const targetSchema = z.enum(['staging', 'production']);
export const VerificationRequestSchema = z.strictObject({
  jobId: z.uuid(),
  target: targetSchema,
  actor: z.string().regex(/^github:[1-9][0-9]*$/),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,100}$/),
  expectedAttempts: z.number().int().min(0).max(6),
  requestId: z.string().min(1).max(200),
});
export const VerificationRecoverySchema = VerificationRequestSchema.omit({
  expectedAttempts: true,
}).extend({
  verificationId: z.uuid(),
  expectedDispatches: z.number().int().min(0).max(MAX_DISPATCH_ATTEMPTS),
  action: z.enum(['reconcile', 'retry']),
});
export const VerificationSourceSchema = z.strictObject({
  target: targetSchema,
  deploymentId: identifier,
  runId: identifier,
  checkRunId: identifier,
  dispatchRevision: sha,
  workflowRevision: sha,
  workerVersionId: z.uuid().optional(),
  build: PublicationBuildSchema,
});
const authority = `u.active=1 AND ((j.environment='staging' AND u.role IN ('publisher','administrator') AND ?='staging')
  OR (j.environment='production-merge' AND u.role='administrator' AND ?='production'))`;
const captured = `j.status='running' AND ps.target=? AND pr.dispatch_count=?
  AND pr.run_id=pr.reserved_run_id AND pr.run_attempt=pr.reserved_run_attempt
  AND pr.check_run_id IS NOT NULL AND pr.commit_authorized_at IS NOT NULL AND pr.deploy_authorized_at IS NOT NULL`;

const verificationFrom = `FROM publication_verifications v JOIN publish_jobs j ON j.id=v.job_id
  JOIN publication_inputs pi ON pi.job_id=j.id JOIN publication_runs pr ON pr.job_id=j.id
  JOIN publication_slots ps ON ps.job_id=j.id JOIN user_roles u ON u.email=v.requested_by
  WHERE v.id=? AND v.status IN ('queued','running') AND j.status='running' AND ps.target=v.target AND u.active=1
    AND ((v.target='staging' AND j.environment='staging' AND u.role IN ('publisher','administrator'))
      OR (v.target='production' AND j.environment='production-merge' AND u.role='administrator'))
    AND pr.deploy_authorized_at IS NOT NULL AND pr.commit_authorized_at IS NOT NULL
    AND pr.run_id=json_extract(v.source_json,'$.runId') AND pr.run_attempt=v.original_run_attempt
    AND pr.check_run_id=json_extract(v.source_json,'$.checkRunId')
    AND pr.dispatch_revision=json_extract(v.source_json,'$.dispatchRevision')
    AND pi.workflow_revision=json_extract(v.source_json,'$.workflowRevision')
    AND j.result_sha=json_extract(v.source_json,'$.build.commitSha')
    AND j.candidate_checksum=json_extract(v.source_json,'$.build.candidateChecksum')
    AND json(pr.build_json)=json_extract(v.source_json,'$.build')`;
type VerificationRow = {
  id: string;
  job_id: string;
  target: 'staging' | 'production';
  requested_by: string;
  github_login: string;
  nonce: string;
  workflow_revision: string;
  source_json: string;
  status: string;
  attempt: number;
  dispatch_count: number;
  reserved_run_id: string | null;
  reserved_run_attempt: string | null;
  reserved_check_run_id: string | null;
  check_run_id: string | null;
  report_json: string | null;
  original_run_attempt: string;
  native_worker_deployment_id: string | null;
};

/** Recovery retains public facts and receives no permission to execute a deployment. */
export class D1PublicationVerifier {
  constructor(
    private readonly database: D1Database,
    private readonly config: PublisherConfig & { workflowRevision: string },
    private readonly callerBlobs: Record<'staging' | 'production', string>,
    private readonly nativeReadToken?: string,
    private readonly keys?: JWTVerifyGetKey,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private request: typeof fetch = (url, init) => {
    const fetcher = this.fetcher;
    return fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  };

  async status(jobId: string, target: 'staging' | 'production', actor: string) {
    z.uuid().parse(jobId);
    targetSchema.parse(target);
    const allowed = this.database
      .prepare(
        `SELECT 1 FROM publish_jobs j JOIN user_roles u ON u.email=? WHERE j.id=? AND ${authority}`,
      )
      .bind(actor, jobId, target, target);
    if (!(await allowed.first())) throw new Error('PUBLISH_AUTHORITY_CHANGED');
    const row = await this.database
      .prepare(
        `SELECT id,status,attempt,requested_at,dispatch_count,dispatch_after,dispatch_error,
      reserved_run_id,report_json IS NOT NULL AS reported FROM publication_verifications WHERE job_id=? AND target=? ORDER BY attempt DESC LIMIT 1`,
      )
      .bind(jobId, target)
      .first<{
        id: string;
        status: 'queued' | 'running' | 'passed' | 'failed';
        attempt: number;
        requested_at: string;
        dispatch_count: number;
        dispatch_after: string;
        dispatch_error: string | null;
        reserved_run_id: string | null;
        reported: number;
      }>();
    if (!(await allowed.first())) throw new Error('PUBLISH_AUTHORITY_CHANGED');
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      attempt: row.attempt,
      requestedAt: row.requested_at,
      dispatchAttempts: row.dispatch_count,
      retryAt: row.dispatch_after,
      reported: row.reported === 1,
      needsAttention:
        row.status === 'failed' ||
        (row.status === 'queued' &&
          !row.reserved_run_id &&
          row.dispatch_count >= MAX_DISPATCH_ATTEMPTS),
      ...(row.dispatch_error ? { failureCode: row.dispatch_error } : {}),
      ...(row.reserved_run_id && identifier.safeParse(row.reserved_run_id).success
        ? {
            workflowUrl: `https://github.com/PointCommunity/${target === 'staging' ? 'pointsite-staging' : 'pointsite'}/actions/runs/${row.reserved_run_id}`,
          }
        : {}),
    };
  }

  /** Durable retries reuse the same verification identity and never execute deployment. */
  async dispatch(id: string): Promise<void> {
    z.uuid().parse(id);
    const eligible = `${verificationFrom} AND v.status='queued' AND v.reserved_run_id IS NULL`;
    const row = await this.database
      .prepare(`SELECT v.*,u.github_login ${eligible}`)
      .bind(id)
      .first<VerificationRow>();
    if (!row) throw new Error('PUBLICATION_VERIFICATION_DISPATCH_UNAVAILABLE');
    const reserved = await this.database
      .prepare(
        `UPDATE publication_verifications SET dispatch_after=strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || (60 << dispatch_count) || ' seconds'),
      dispatch_count=dispatch_count+1,dispatch_error=NULL WHERE id=? AND dispatch_count<${MAX_DISPATCH_ATTEMPTS}
      AND dispatch_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 ${eligible} AND u.github_login=?)`,
      )
      .bind(id, id, row.github_login)
      .run();
    if (!reserved.meta.changes) throw new Error('PUBLICATION_VERIFICATION_BACKOFF');
    try {
      const source = VerificationSourceSchema.parse(JSON.parse(row.source_json));
      const repository = row.target === 'staging' ? 'pointsite-staging' : 'pointsite';
      const token = await createPublisherToken({
        ...this.config,
        repository,
        subject: row.requested_by,
        login: row.github_login,
        fetcher: this.request,
      });
      const headers = { ...githubHeaders(token), 'content-type': 'application/json' };
      const api = `https://api.github.com/repos/PointCommunity/${repository}`;
      z.object({ object: z.object({ sha: z.literal(source.build.commitSha) }) }).parse(
        await publicationJson(await this.request(`${api}/git/ref/heads/main`, { headers }), 8192),
      );
      // Local revocation or another signed run reservation wins after provider reads.
      const current = await this.database
        .prepare(`SELECT 1 ${eligible} AND u.github_login=? AND v.nonce=? AND v.source_json=?`)
        .bind(id, row.github_login, row.nonce, row.source_json)
        .first();
      if (!current) throw new Error('PUBLICATION_VERIFICATION_DISPATCH_UNAVAILABLE');
      const response = await this.request(`${api}/dispatches`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          event_type: 'verify-publication',
          client_payload: { verificationId: id, nonce: row.nonce },
        }),
      });
      if (response.status !== 204) {
        const retry = Number(response.headers.get('retry-after'));
        const seconds = Number.isFinite(retry)
          ? Math.min(3600, Math.max(60, Math.ceil(retry)))
          : 60;
        await this.database
          .prepare(
            "UPDATE publication_verifications SET dispatch_after=MAX(dispatch_after,strftime('%Y-%m-%dT%H:%M:%fZ','now',?)) WHERE id=?",
          )
          .bind(`+${seconds} seconds`, id)
          .run();
        throw new Error('PUBLICATION_VERIFICATION_DISPATCH_UNCONFIRMED');
      }
    } catch (error) {
      const code =
        error instanceof Error && error.message === 'PUBLICATION_VERIFICATION_DISPATCH_UNAVAILABLE'
          ? error.message
          : 'PUBLICATION_VERIFICATION_DISPATCH_UNCONFIRMED';
      await this.database
        .prepare('UPDATE publication_verifications SET dispatch_error=? WHERE id=?')
        .bind(code, id)
        .run();
      throw new Error(code);
    }
  }

  async dispatchPending(): Promise<void> {
    // At most two held publication slots; do not scan retained job history.
    const pending = await this.database
      .prepare(
        `SELECT v.id FROM publication_slots ps JOIN publication_verifications v ON v.job_id=ps.job_id
      JOIN publish_jobs j ON j.id=v.job_id JOIN user_roles u ON u.email=v.requested_by
      WHERE v.status='queued' AND v.reserved_run_id IS NULL AND j.status='running' AND v.target=ps.target
      AND v.dispatch_count<${MAX_DISPATCH_ATTEMPTS} AND v.dispatch_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND u.active=1 AND ((v.target='staging' AND u.role IN ('publisher','administrator')) OR (v.target='production' AND u.role='administrator'))
      ORDER BY v.dispatch_after,v.id LIMIT 1`,
      )
      .first<{ id: string }>();
    if (!pending) return;
    try {
      await this.dispatch(pending.id);
    } catch (error) {
      if (!(error instanceof Error && /^PUBLICATION_VERIFICATION_[A-Z_]+$/.test(error.message)))
        throw new Error('PUBLICATION_VERIFICATION_DISPATCH_UNCONFIRMED');
    }
  }

  private async authenticate(id: string, token: string) {
    if (!z.uuid().safeParse(id).success) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    const row = await this.database
      .prepare(`SELECT v.*,u.github_login ${verificationFrom}`)
      .bind(id)
      .first<VerificationRow>();
    if (!row) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    const source = VerificationSourceSchema.parse(JSON.parse(row.source_json));
    const scope: PublicationRunnerScope = {
      purpose: 'verification',
      jobId: id,
      target: row.target,
      nonce: row.nonce,
      workflowRevision: row.workflow_revision,
      dispatchRevision: source.build.commitSha,
      ...(row.reserved_run_id && row.reserved_run_attempt
        ? { run: { id: row.reserved_run_id, attempt: row.reserved_run_attempt } }
        : {}),
    };
    const identity = await verifyPublicationRunner(token, scope, this.keys);
    return { row, source, scope, identity };
  }

  private guard(
    context: Awaited<ReturnType<D1PublicationVerifier['authenticate']>>,
    mode: 'execute' | 'claim' | 'finalize' = 'execute',
  ) {
    const { row, scope, identity } = context;
    return this.database
      .prepare(
        `SELECT json(CASE WHEN EXISTS(SELECT 1 ${verificationFrom}
      AND v.nonce=? AND v.workflow_revision=? AND v.source_json=? AND v.reserved_run_id=? AND v.reserved_run_attempt=?
      AND v.reserved_check_run_id!=? AND (v.check_run_id${mode === 'finalize' ? '!=' : '='}? ${mode === 'claim' ? 'OR v.check_run_id IS NULL' : ''})
      ${mode === 'claim' ? '' : "AND v.status='running'"}
      ) THEN 'true' ELSE 'publication verification no longer authorized' END)`,
      )
      .bind(
        row.id,
        scope.nonce,
        scope.workflowRevision,
        row.source_json,
        identity.runId,
        identity.runAttempt,
        identity.checkRunId,
        identity.checkRunId,
      );
  }

  async reserve(id: string, token: string) {
    const { row, scope, identity } = await this.authenticate(id, token);
    await this.database.batch([
      this.database
        .prepare(
          `SELECT json(CASE WHEN EXISTS(SELECT 1 ${verificationFrom}
        AND v.nonce=? AND v.workflow_revision=? AND v.source_json=? AND v.status='queued'
        AND v.check_run_id IS NULL AND (v.reserved_run_id IS NULL OR
          (v.reserved_run_id=? AND v.reserved_run_attempt=? AND v.reserved_check_run_id=?))
        ) THEN 'true' ELSE 'publication verification no longer authorized' END)`,
        )
        .bind(
          id,
          scope.nonce,
          scope.workflowRevision,
          row.source_json,
          identity.runId,
          identity.runAttempt,
          identity.checkRunId,
        ),
      this.database
        .prepare(
          'UPDATE publication_verifications SET reserved_run_id=?,reserved_run_attempt=?,reserved_check_run_id=? WHERE id=?',
        )
        .bind(identity.runId, identity.runAttempt, identity.checkRunId, id),
    ]);
    return { reserved: true as const };
  }

  async claim(id: string, token: string) {
    const context = await this.authenticate(id, token);
    await this.database.batch([
      this.guard(context, 'claim'),
      this.database
        .prepare("UPDATE publication_verifications SET status='running',check_run_id=? WHERE id=?")
        .bind(context.identity.checkRunId, id),
    ]);
    return { claimed: true as const };
  }

  async inputs(id: string, token: string) {
    const context = await this.authenticate(id, token);
    await this.guard(context).first();
    return context.source;
  }

  async report(id: string, token: string, value: unknown) {
    const context = await this.authenticate(id, token);
    const { source } = context;
    const report = z
      .strictObject({
        artifactDigest: z.literal(source.build.artifactDigest),
        deploymentId: z.literal(source.deploymentId),
        ...(source.target === 'staging'
          ? { workerVersionId: z.literal(source.workerVersionId!) }
          : {}),
      })
      .parse(value);
    await this.database.batch([
      this.guard(context),
      this.database
        .prepare('UPDATE publication_verifications SET report_json=? WHERE id=?')
        .bind(JSON.stringify(report), id),
    ]);
    return { recorded: true as const };
  }

  /** The report is provisional until a separate signed check verifies native completion. */
  async finalize(id: string, token: string) {
    if (await this.completedReceipt(id, token)) return { verified: true as const };
    try {
      const context = await this.authenticate(id, token);
      return await this.complete(
        context.row,
        context.source,
        this.guard(context, 'finalize'),
        context.row.requested_by,
        crypto.randomUUID(),
      );
    } catch (error) {
      if (await this.completedReceipt(id, token)) return { verified: true as const };
      throw error;
    }
  }

  private async complete(
    row: VerificationRow,
    source: z.infer<typeof VerificationSourceSchema>,
    guard: D1PreparedStatement,
    actor: string,
    requestId: string,
    receipt?: { key: string; hash: string },
  ) {
    const id = row.id;
    const report = z
      .strictObject({
        artifactDigest: z.literal(source.build.artifactDigest),
        deploymentId: z.literal(source.deploymentId),
        ...(source.target === 'staging'
          ? { workerVersionId: z.literal(source.workerVersionId!) }
          : {}),
      })
      .parse(JSON.parse(row.report_json ?? 'null'));
    await guard.first();
    const githubToken = await createPublisherToken({
      ...this.config,
      repository: source.target === 'staging' ? 'pointsite-staging' : 'pointsite',
      subject: actor,
      login: row.github_login,
      fetcher: this.request,
    });
    await verifyTerminalRun(
      {
        target: source.target,
        run_id: source.runId,
        run_attempt: row.original_run_attempt,
        dispatch_revision: source.dispatchRevision,
        workflow_revision: source.workflowRevision,
      },
      this.request,
      githubToken,
    );
    if (receipt)
      await verifyTerminalRun(
        {
          purpose: 'verification',
          target: row.target,
          run_id: row.reserved_run_id,
          run_attempt: row.reserved_run_attempt,
          dispatch_revision: source.build.commitSha,
          workflow_revision: row.workflow_revision,
        },
        this.request,
        githubToken,
      );
    if (source.target === 'staging') {
      const native = await verifyStagingDeployment(
        source.build.commitSha,
        source.build.candidateChecksum,
        this.nativeReadToken ?? '',
        this.request,
      );
      if (
        native.deploymentId !== row.native_worker_deployment_id ||
        native.workerVersionId !== source.workerVersionId
      )
        throw new Error('PUBLICATION_VERIFICATION_UNCONFIRMED');
    }
    const evidence = PublicationEvidenceSchema.parse({
      ...(await verifyDeploymentProof(
        {
          target: source.target,
          runId: source.runId,
          checkRunId: source.checkRunId,
          dispatchRevision: source.dispatchRevision,
          workflowRevision: source.workflowRevision,
          commitSha: source.build.commitSha,
          candidateChecksum: source.build.candidateChecksum,
          artifactDigest: report.artifactDigest,
          ...(source.workerVersionId ? { workerVersionId: source.workerVersionId } : {}),
          verification: {
            runId: row.reserved_run_id!,
            checkRunId: row.check_run_id!,
            dispatchRevision: source.build.commitSha,
            workflowRevision: row.workflow_revision,
          },
        },
        this.request,
        githubToken,
      )),
      verificationStatus: 'passed',
    });
    if (evidence.deploymentId !== source.deploymentId)
      throw new Error('PUBLICATION_VERIFICATION_UNCONFIRMED');
    const deployment =
      source.target === 'staging'
        ? { workerVersionId: source.workerVersionId }
        : { artifactDigest: source.build.artifactDigest };
    await this.database.batch([
      guard,
      ...(receipt
        ? [
            this.database
              .prepare(
                "INSERT INTO publication_recovery_receipts(idempotency_key,job_id,action,request_hash) VALUES (?,?,'retry',?)",
              )
              .bind(receipt.key, row.job_id, receipt.hash),
          ]
        : []),
      this.database
        .prepare(
          'UPDATE publication_runs SET deployment_json=COALESCE(deployment_json,?) WHERE job_id=?',
        )
        .bind(JSON.stringify(deployment), row.job_id),
      this.database
        .prepare(
          "UPDATE publication_verifications SET status='passed',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
        )
        .bind(id),
      this.database
        .prepare(
          "UPDATE publish_jobs SET status='succeeded',evidence_json=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
        )
        .bind(JSON.stringify(evidence), row.job_id),
      verifiedReleaseStatement(this.database, row.job_id),
      this.database
        .prepare("DELETE FROM publication_slots WHERE target='production' AND job_id=?")
        .bind(row.job_id),
      this.database
        .prepare(
          `INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
          VALUES (?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,'publish.verification-completed','publish-job',?,'succeeded',?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          row.job_id,
          requestId,
          JSON.stringify({ verificationId: id }),
        ),
    ]);
    return { verified: true as const };
  }

  private async recoveryRequest(
    value: z.infer<typeof VerificationRecoverySchema>,
    action: 'reconcile' | 'retry',
  ) {
    const input = VerificationRecoverySchema.parse(value);
    if (input.action !== action) throw new Error('PUBLICATION_VERIFICATION_CHANGED');
    const allowed = this.database
      .prepare(
        `SELECT 1 FROM publication_verifications v JOIN publish_jobs j ON j.id=v.job_id
      JOIN user_roles u ON u.email=? WHERE v.id=? AND v.job_id=? AND v.target=? AND ${authority}`,
      )
      .bind(
        input.actor,
        input.verificationId,
        input.jobId,
        input.target,
        input.target,
        input.target,
      );
    if (!(await allowed.first())) throw new Error('PUBLISH_AUTHORITY_CHANGED');
    const hash = await checksumDocument({
      jobId: input.jobId,
      verificationId: input.verificationId,
      actor: input.actor,
      target: input.target,
      expectedDispatches: input.expectedDispatches,
      action: input.action,
    });
    const receipt = async () => {
      const prior = await this.database
        .prepare('SELECT request_hash FROM publication_recovery_receipts WHERE idempotency_key=?')
        .bind(input.idempotencyKey)
        .first<{ request_hash: string }>();
      if (!prior) return false;
      if (prior.request_hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
      if (!(await allowed.first())) throw new Error('PUBLISH_AUTHORITY_CHANGED');
      return true;
    };
    return { input, hash, receipt };
  }

  /** A fresh publisher can record a completed proof even after the original requester loses access. */
  async reconcile(value: z.infer<typeof VerificationRecoverySchema>) {
    const { input, hash, receipt } = await this.recoveryRequest(value, 'reconcile');
    if (await receipt()) return { recovered: true as const };
    const eligible = verificationFrom.replace('u.email=v.requested_by', 'u.email=?');
    const row = await this.database
      .prepare(
        `SELECT v.*,u.github_login ${eligible} AND v.target=? AND v.job_id=? AND v.dispatch_count=?`,
      )
      .bind(input.actor, input.verificationId, input.target, input.jobId, input.expectedDispatches)
      .first<VerificationRow>();
    if (!row) throw new Error('PUBLICATION_VERIFICATION_CHANGED');
    const source = VerificationSourceSchema.parse(JSON.parse(row.source_json));
    const guard = this.database
      .prepare(
        `SELECT json(CASE WHEN EXISTS(SELECT 1 ${eligible}
      AND v.target=? AND v.job_id=? AND v.dispatch_count=? AND v.status='running'
      AND v.source_json=? AND v.nonce=? AND v.workflow_revision=? AND v.reserved_run_id=?
      AND v.reserved_run_attempt=? AND v.check_run_id=? AND v.report_json=? AND u.github_login=?
      ) THEN 'true' ELSE 'publication verification changed' END)`,
      )
      .bind(
        input.actor,
        input.verificationId,
        input.target,
        input.jobId,
        input.expectedDispatches,
        row.source_json,
        row.nonce,
        row.workflow_revision,
        row.reserved_run_id,
        row.reserved_run_attempt,
        row.check_run_id,
        row.report_json,
        row.github_login,
      );
    try {
      await this.complete(row, source, guard, input.actor, input.requestId, {
        key: input.idempotencyKey,
        hash,
      });
      return { recovered: true as const };
    } catch (error) {
      if (await receipt()) return { recovered: true as const };
      if (
        error instanceof Error &&
        [
          'PUBLICATION_RUN_NOT_TERMINAL',
          'PUBLICATION_VERIFICATION_UNCONFIRMED',
          'PUBLISH_GITHUB_AUTHORITY_CHANGED',
        ].includes(error.message)
      )
        throw error;
      throw new Error('PUBLICATION_VERIFICATION_CHANGED');
    }
  }

  private async captureRetry(input: z.infer<typeof VerificationRecoverySchema>) {
    const original = await this.database
      .prepare('SELECT dispatch_count FROM publication_runs WHERE job_id=?')
      .bind(input.jobId)
      .first<{ dispatch_count: number }>();
    if (!original) throw new Error('PUBLICATION_VERIFICATION_CHANGED');
    return this.capture({
      jobId: input.jobId,
      target: input.target,
      actor: input.actor,
      expectedAttempts: original.dispatch_count,
      requestId: input.requestId,
      idempotencyKey: await checksumDocument({ verificationRetryKey: input.idempotencyKey }),
    });
  }

  async retry(value: z.infer<typeof VerificationRecoverySchema>) {
    const { input, hash, receipt } = await this.recoveryRequest(value, 'retry');
    if (await receipt()) return this.captureRetry(input);
    const eligible = verificationFrom.replace('u.email=v.requested_by', 'u.email=?');
    const row = await this.database
      .prepare(
        `SELECT v.*,u.github_login ${eligible} AND v.target=? AND v.job_id=? AND v.dispatch_count=?`,
      )
      .bind(input.actor, input.verificationId, input.target, input.jobId, input.expectedDispatches)
      .first<VerificationRow>();
    if (!row) throw new Error('PUBLICATION_VERIFICATION_CHANGED');
    if (row.report_json) throw new Error('PUBLICATION_VERIFICATION_RECONCILE_REQUIRED');
    if (row.attempt >= 3) throw new Error('PUBLICATION_VERIFICATION_LIMIT');
    if (row.reserved_run_id) {
      const source = VerificationSourceSchema.parse(JSON.parse(row.source_json));
      const token = await createPublisherToken({
        ...this.config,
        repository: input.target === 'staging' ? 'pointsite-staging' : 'pointsite',
        subject: input.actor,
        login: row.github_login,
        fetcher: this.request,
      });
      await verifyTerminalRun(
        {
          purpose: 'verification',
          target: input.target,
          run_id: row.reserved_run_id,
          run_attempt: row.reserved_run_attempt,
          dispatch_revision: source.build.commitSha,
          workflow_revision: row.workflow_revision,
        },
        this.request,
        token,
      );
    } else if (row.dispatch_count !== MAX_DISPATCH_ATTEMPTS) {
      throw new Error('PUBLICATION_VERIFICATION_BACKOFF');
    }
    try {
      await this.database.batch([
        this.database
          .prepare(
            `SELECT json(CASE WHEN EXISTS(SELECT 1 ${eligible}
          AND v.target=? AND v.job_id=? AND v.dispatch_count=? AND v.report_json IS NULL AND v.attempt<3
          AND v.source_json=? AND v.nonce=? AND v.reserved_run_id IS ? AND v.reserved_run_attempt IS ?
          AND v.check_run_id IS ? AND u.github_login=?
          ) THEN 'true' ELSE 'publication verification changed' END)`,
          )
          .bind(
            input.actor,
            input.verificationId,
            input.target,
            input.jobId,
            input.expectedDispatches,
            row.source_json,
            row.nonce,
            row.reserved_run_id,
            row.reserved_run_attempt,
            row.check_run_id,
            row.github_login,
          ),
        this.database
          .prepare(
            "INSERT INTO publication_recovery_receipts(idempotency_key,job_id,action,request_hash) VALUES (?,?,'retry',?)",
          )
          .bind(input.idempotencyKey, input.jobId, hash),
        this.database
          .prepare(
            "UPDATE publication_verifications SET status='failed',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
          )
          .bind(input.verificationId),
        this.database
          .prepare(
            `INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
          VALUES (?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,'publish.verification-retired','publish-job',?,'succeeded',?,?)`,
          )
          .bind(
            crypto.randomUUID(),
            input.actor,
            input.jobId,
            input.requestId,
            JSON.stringify({ verificationId: input.verificationId }),
          ),
      ]);
    } catch {
      if (!(await receipt())) throw new Error('PUBLICATION_VERIFICATION_CHANGED');
    }
    // A lost reply between retirement and capture resumes with this same derived key.
    return this.captureRetry(input);
  }

  private async completedReceipt(id: string, token: string) {
    const row = await this.database
      .prepare(
        `SELECT v.*,j.evidence_json FROM publication_verifications v
      JOIN publish_jobs j ON j.id=v.job_id JOIN user_roles u ON u.email=v.requested_by
      WHERE v.id=? AND v.status='passed' AND j.status='succeeded' AND u.active=1
        AND ((v.target='staging' AND j.environment='staging' AND u.role IN ('publisher','administrator'))
          OR (v.target='production' AND j.environment='production-merge' AND u.role='administrator'))`,
      )
      .bind(id)
      .first<VerificationRow & { evidence_json: string }>();
    if (!row) return false;
    const source = VerificationSourceSchema.parse(JSON.parse(row.source_json));
    const identity = await verifyPublicationRunner(
      token,
      {
        purpose: 'verification',
        jobId: id,
        target: row.target,
        nonce: row.nonce,
        workflowRevision: row.workflow_revision,
        dispatchRevision: source.build.commitSha,
        run: { id: row.reserved_run_id!, attempt: row.reserved_run_attempt! },
      },
      this.keys,
    );
    const evidence = PublicationEvidenceSchema.parse(JSON.parse(row.evidence_json));
    if (
      identity.checkRunId === row.reserved_check_run_id ||
      identity.checkRunId === row.check_run_id ||
      evidence.runId !== source.runId ||
      evidence.checkRunId !== source.checkRunId ||
      evidence.workflowRevision !== source.workflowRevision ||
      evidence.dispatchRevision !== source.dispatchRevision ||
      evidence.commitSha !== source.build.commitSha ||
      evidence.artifactDigest !== source.build.artifactDigest ||
      evidence.candidateChecksum !== source.build.candidateChecksum ||
      evidence.deploymentId !== source.deploymentId ||
      evidence.workerVersionId !== source.workerVersionId ||
      evidence.verification?.runId !== row.reserved_run_id ||
      evidence.verification.checkRunId !== row.check_run_id ||
      evidence.verification.workflowRevision !== row.workflow_revision ||
      evidence.verification.dispatchRevision !== source.build.commitSha
    )
      throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    return true;
  }

  async capture(value: z.infer<typeof VerificationRequestSchema>) {
    const input = VerificationRequestSchema.parse(value);
    sha.parse(this.config.workflowRevision);
    sha.parse(this.callerBlobs[input.target]);
    const actor = this.database
      .prepare(
        `SELECT u.github_login FROM user_roles u JOIN publish_jobs j ON j.id=? WHERE u.email=? AND ${authority}`,
      )
      .bind(input.jobId, input.actor, input.target, input.target);
    const account = await actor.first<{ github_login: string }>();
    if (!account) throw new Error('PUBLISH_AUTHORITY_CHANGED');
    const requestHash = await checksumDocument({
      jobId: input.jobId,
      actor: input.actor,
      target: input.target,
      expectedAttempts: input.expectedAttempts,
    });
    const receipt = async () => {
      const prior = await this.database
        .prepare('SELECT id,request_hash FROM publication_verifications WHERE idempotency_key=?')
        .bind(input.idempotencyKey)
        .first<{ id: string; request_hash: string }>();
      if (!prior) return null;
      if (prior.request_hash !== requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
      if (!(await actor.first())) throw new Error('PUBLISH_AUTHORITY_CHANGED');
      return { recovered: true as const, verificationId: prior.id };
    };
    const existing = await receipt();
    if (existing) return existing;
    const prior = await this.database
      .prepare(
        'SELECT attempt,status FROM publication_verifications WHERE job_id=? ORDER BY attempt DESC LIMIT 1',
      )
      .bind(input.jobId)
      .first<{ attempt: number; status: string }>();
    if (prior && ['queued', 'running'].includes(prior.status))
      throw new Error('PUBLICATION_VERIFICATION_BUSY');
    const attempt = (prior?.attempt ?? 0) + 1;
    if (attempt > 3) throw new Error('PUBLICATION_VERIFICATION_LIMIT');
    const source = await this.database
      .prepare(
        `SELECT pr.run_id,pr.run_attempt,pr.check_run_id,pr.dispatch_revision,pr.build_json,
      pr.deployment_json,j.result_sha,j.candidate_checksum,pi.workflow_revision
      FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id JOIN publication_runs pr ON pr.job_id=j.id
      JOIN publication_slots ps ON ps.job_id=j.id WHERE j.id=? AND ${captured}`,
      )
      .bind(input.jobId, input.target, input.expectedAttempts)
      .first<{
        run_id: string;
        run_attempt: string;
        check_run_id: string;
        dispatch_revision: string;
        workflow_revision: string;
        build_json: string;
        deployment_json: string | null;
        result_sha: string;
        candidate_checksum: string;
      }>();
    if (!source) throw new Error('PUBLICATION_VERIFICATION_CHANGED');
    const build = PublicationBuildSchema.parse(JSON.parse(source.build_json));
    if (
      source.result_sha !== build.commitSha ||
      source.candidate_checksum !== build.candidateChecksum
    )
      throw new Error('PUBLICATION_VERIFICATION_CHANGED');
    await verifyTerminalRun({ target: input.target, ...source }, this.request);
    const repository = input.target === 'staging' ? 'pointsite-staging' : 'pointsite';
    const token = await createPublisherToken({
      ...this.config,
      repository,
      subject: input.actor,
      login: account.github_login,
      fetcher: this.request,
    });
    const api = `https://api.github.com/repos/PointCommunity/${repository}`;
    const read = async (path: string) =>
      publicationJson(
        await this.request(`${api}${path}`, { headers: githubHeaders(token) }),
        65_536,
      );
    z.object({ object: z.object({ sha: z.literal(build.commitSha) }) }).parse(
      await read('/git/ref/heads/main'),
    );
    const caller = z
      .object({ type: z.literal('file'), sha })
      .parse(
        await read(`/contents/.github/workflows/verify-publication.yml?ref=${build.commitSha}`),
      );
    if (caller.sha !== this.callerBlobs[input.target])
      throw new Error('PUBLICATION_VERIFICATION_CHANGED');
    const environment = input.target === 'staging' ? 'staging' : 'github-pages';
    const [deployment] = z
      .array(
        z.object({
          id: z.number().int().positive(),
          sha: z.literal(source.dispatch_revision),
          environment: z.literal(environment),
          performed_via_github_app: z.object({
            id: z.literal(15368),
            slug: z.literal('github-actions'),
          }),
        }),
      )
      .length(1)
      .parse(await read(`/deployments?environment=${environment}&per_page=1`));
    const native =
      input.target === 'staging'
        ? await verifyStagingDeployment(
            build.commitSha,
            build.candidateChecksum,
            this.nativeReadToken ?? '',
            this.request,
          )
        : undefined;
    if (source.deployment_json !== null) {
      (input.target === 'staging'
        ? z.strictObject({ workerVersionId: z.literal(native!.workerVersionId) })
        : z.strictObject({ artifactDigest: z.literal(build.artifactDigest) })
      ).parse(JSON.parse(source.deployment_json));
    }
    const selected = VerificationSourceSchema.parse({
      target: input.target,
      deploymentId: String(deployment.id),
      runId: source.run_id,
      checkRunId: source.check_run_id,
      dispatchRevision: source.dispatch_revision,
      workflowRevision: source.workflow_revision,
      ...(native ? { workerVersionId: native.workerVersionId } : {}),
      build,
    });
    const id = crypto.randomUUID();
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    try {
      await this.database.batch([
        this.database
          .prepare(
            `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM publish_jobs j
          JOIN publication_inputs pi ON pi.job_id=j.id JOIN publication_runs pr ON pr.job_id=j.id
          JOIN publication_slots ps ON ps.job_id=j.id JOIN user_roles u ON u.email=?
          WHERE j.id=? AND ${authority} AND ${captured} AND u.github_login=?
            AND pr.run_id=? AND pr.run_attempt=? AND pr.check_run_id=? AND pr.dispatch_revision=?
            AND pi.workflow_revision=? AND pr.build_json=? AND pr.deployment_json IS ? AND j.result_sha=?
            AND COALESCE((SELECT MAX(attempt) FROM publication_verifications WHERE job_id=j.id),0)=?
            AND NOT EXISTS(SELECT 1 FROM publication_verifications WHERE job_id=j.id AND status IN ('queued','running'))
          ) THEN 'true' ELSE 'publication verification changed' END)`,
          )
          .bind(
            input.actor,
            input.jobId,
            input.target,
            input.target,
            input.target,
            input.expectedAttempts,
            account.github_login,
            source.run_id,
            source.run_attempt,
            source.check_run_id,
            source.dispatch_revision,
            source.workflow_revision,
            source.build_json,
            source.deployment_json,
            build.commitSha,
            attempt - 1,
          ),
        this.database
          .prepare(
            `INSERT INTO publication_verifications(id,job_id,attempt,idempotency_key,request_hash,requested_by,target,
          nonce,workflow_revision,source_json,original_run_attempt,native_worker_deployment_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            id,
            input.jobId,
            attempt,
            input.idempotencyKey,
            requestHash,
            input.actor,
            input.target,
            nonce,
            this.config.workflowRevision,
            JSON.stringify(selected),
            source.run_attempt,
            native?.deploymentId ?? null,
          ),
        this.database
          .prepare(
            `INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
          VALUES (?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,'publish.verification-captured','publish-job',?,'succeeded',?,?)`,
          )
          .bind(
            crypto.randomUUID(),
            input.actor,
            input.jobId,
            input.requestId,
            JSON.stringify({ verificationId: id, attempt }),
          ),
      ]);
    } catch {
      const duplicate = await receipt();
      if (duplicate) return duplicate;
      throw new Error('PUBLICATION_VERIFICATION_CHANGED');
    }
    return { recovered: true as const, verificationId: id };
  }
}
