import { z } from 'zod';
import { checksumDocument } from '../../site-kit/canonicalize';
import { CloudCandidateTupleSchema, D1ApprovalService } from '../approvals/service';
import { createPublisherToken, githubHeaders } from '../github/app-auth';
import { PublicationBuildSchema, publicationJson } from './build-proof';
import { PublicationEvidenceSchema, verifyDeploymentProof } from './deployment-proof';
import type { PublisherConfig } from './service';
import { retryCapturedPublication } from './retry';
import {
  QueuedRecoverySchema,
  recoverQueuedPublication,
  type QueuedRecoveryInput,
} from './recovery';
import { reconcileCompletedPublication } from './reconcile';
import { D1PublishJobStore, type PublishJobStatus } from './jobs';

/** Shared by dispatch and every signed runner boundary; aliases belong to their job queries. */
export const currentPromotion = `EXISTS (
  SELECT 1 FROM publication_promotions promotion JOIN approvals accepted ON accepted.id=promotion.approval_id
  WHERE promotion.job_id=j.id AND accepted.decision='approved'
    AND accepted.publish_job_id=promotion.staging_job_id
    AND accepted.candidate_checksum=j.candidate_checksum
    AND ((accepted.production_base_sha=j.base_sha AND NOT EXISTS (
      SELECT 1 FROM publication_retries WHERE job_id=j.id)) OR EXISTS (
      SELECT 1 FROM publication_retries lineage JOIN publication_promotions parent ON parent.job_id=lineage.parent_job_id
      WHERE lineage.job_id=j.id AND parent.approval_id=promotion.approval_id
        AND parent.staging_job_id=promotion.staging_job_id AND parent.artifact_digest=promotion.artifact_digest))
    AND json_extract(accepted.candidate_json,'$.workflowRevision')=pi.workflow_revision
    AND json_extract(accepted.candidate_json,'$.artifactDigest')=promotion.artifact_digest
    AND accepted.id=(SELECT id FROM approvals WHERE gate='staging-acceptance'
      AND publish_job_id=promotion.staging_job_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
)`;

export const ProductionCaptureSchema = z.strictObject({
  stagingJobId: z.uuid(),
  approvalId: z.uuid(),
  tuple: CloudCandidateTupleSchema,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,100}$/),
  actor: z.string().regex(/^github:[1-9][0-9]*$/),
  requestId: z.string().min(1).max(200),
});

export class D1ProductionPublisher {
  constructor(
    private readonly database: D1Database,
    private readonly config: PublisherConfig & { workflowRevision: string },
    private readonly callerBlob: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async workflowForDraft(draftId: string, actor: string) {
    z.uuid().parse(draftId);
    ProductionCaptureSchema.shape.actor.parse(actor);
    const authority = this.database
      .prepare("SELECT 1 FROM user_roles WHERE email=? AND active=1 AND role='administrator'")
      .bind(actor);
    if (!(await authority.first())) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
    const row = await this.database
      .prepare(
        `SELECT j.id,j.status,j.candidate_checksum,j.base_sha,
      j.result_sha,j.requested_at,j.completed_at,j.evidence_json,pi.revision_id,
      p.staging_job_id,p.approval_id,p.artifact_digest
      FROM publication_inputs pi JOIN publish_jobs j ON j.id=pi.job_id
      JOIN publication_promotions p ON p.job_id=j.id
      WHERE pi.draft_id=? AND j.environment='production-merge'
      ORDER BY j.requested_at DESC,j.rowid DESC LIMIT 1`,
      )
      .bind(draftId)
      .first<{
        id: string;
        status: PublishJobStatus;
        candidate_checksum: string;
        base_sha: string;
        result_sha: string | null;
        requested_at: string;
        completed_at: string | null;
        evidence_json: string;
        revision_id: string;
        staging_job_id: string;
        approval_id: string;
        artifact_digest: string;
      }>();
    const occupied = await this.database
      .prepare("SELECT 1 FROM publication_slots WHERE target='production'")
      .first();
    const job = row
      ? {
          id: row.id,
          status: row.status,
          candidateChecksum: row.candidate_checksum,
          revisionId: row.revision_id,
          stagingJobId: row.staging_job_id,
          approvalId: row.approval_id,
          artifactDigest: row.artifact_digest,
          baseSha: row.base_sha,
          commitSha: row.result_sha,
          requestedAt: row.requested_at,
          completedAt: row.completed_at,
          evidence: JSON.parse(row.evidence_json) as Record<string, unknown>,
          dispatch: await new D1PublishJobStore(this.database).dispatchStatus(row.id),
        }
      : null;
    if (!(await authority.first())) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
    return { job, busy: Boolean(occupied) };
  }

  async recoverQueued(value: QueuedRecoveryInput): Promise<{ recovered: true; jobId?: string }> {
    const input = QueuedRecoverySchema.parse(value);
    const source = await this.database
      .prepare("SELECT 1 FROM publish_jobs WHERE id=? AND environment='production-merge'")
      .bind(input.jobId)
      .first();
    if (!source) throw new Error('PUBLICATION_RECOVERY_CHANGED');
    if (input.action === 'retry-captured') return this.retryCaptured(input);
    if (input.action === 'verify-completed')
      return reconcileCompletedPublication(this.database, input, this.fetcher);
    return recoverQueuedPublication(this.database, input, this.fetcher);
  }

  async retryCaptured(value: QueuedRecoveryInput) {
    const input = QueuedRecoverySchema.parse(value);
    return retryCapturedPublication(
      this.database,
      input,
      this.config.workflowRevision,
      async (baseSha) => {
        const source = await this.database
          .prepare(
            `SELECT u.github_login,a.evidence_json
        FROM publication_promotions p JOIN approvals a ON a.id=p.approval_id
        JOIN user_roles u ON u.email=? WHERE p.job_id=? AND u.active=1 AND u.role='administrator'`,
          )
          .bind(input.actor, input.jobId)
          .first<{ github_login: string; evidence_json: string }>();
        if (!source) throw new Error('PUBLICATION_RECOVERY_CHANGED');
        const evidence = PublicationEvidenceSchema.parse(JSON.parse(source.evidence_json));
        const request: typeof fetch = (url, init) =>
          this.fetcher(url, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          });
        await this.verifyDestination(baseSha, input.actor, source.github_login, request);
        const live = await verifyDeploymentProof(
          {
            target: 'staging',
            runId: evidence.runId,
            checkRunId: evidence.checkRunId,
            dispatchRevision: evidence.dispatchRevision,
            commitSha: evidence.commitSha,
            workflowRevision: evidence.workflowRevision,
            candidateChecksum: evidence.candidateChecksum,
            artifactDigest: evidence.artifactDigest,
            workerVersionId: evidence.workerVersionId,
            ...(evidence.verification ? { verification: evidence.verification } : {}),
          },
          request,
        );
        if (live.deploymentId !== evidence.deploymentId)
          throw new Error('PRODUCTION_ACCEPTANCE_CHANGED');
      },
      'production',
    );
  }

  private async verifyDestination(
    baseSha: string,
    subject: string,
    login: string,
    request: typeof fetch,
  ) {
    z.string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(this.callerBlob);
    const token = await createPublisherToken({
      ...this.config,
      repository: 'pointsite',
      subject,
      login,
      fetcher: request,
    });
    const api = 'https://api.github.com/repos/PointCommunity/pointsite';
    const headers = githubHeaders(token);
    z.object({ object: z.object({ sha: z.literal(baseSha) }) }).parse(
      await publicationJson(await request(`${api}/git/ref/heads/main`, { headers }), 8192),
    );
    z.object({ type: z.literal('file'), sha: z.literal(this.callerBlob) }).parse(
      await publicationJson(
        await request(`${api}/contents/.github/workflows/publish-candidate.yml?ref=${baseSha}`, {
          headers,
        }),
        32768,
      ),
    );
  }

  async capture(value: z.infer<typeof ProductionCaptureSchema>) {
    const input = ProductionCaptureSchema.parse(value);
    z.string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(this.callerBlob);
    const requestHash = await checksumDocument({
      stagingJobId: input.stagingJobId,
      approvalId: input.approvalId,
      tuple: input.tuple,
      actor: input.actor,
    });
    const authority = this.database
      .prepare(
        "SELECT github_login FROM user_roles WHERE email=? AND active=1 AND role='administrator'",
      )
      .bind(input.actor);
    const account = await authority.first<{ github_login: string }>();
    if (!account) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
    const receipt = async () => {
      const row = await this.database
        .prepare(
          `SELECT j.id,j.status,p.request_hash
        FROM publish_jobs j LEFT JOIN publication_promotions p ON p.job_id=j.id WHERE j.idempotency_key=?`,
        )
        .bind(input.idempotencyKey)
        .first<{ id: string; status: string; request_hash: string | null }>();
      if (!row) {
        if (
          await this.database
            .prepare('SELECT 1 FROM publication_tombstones WHERE idempotency_key=?')
            .bind(input.idempotencyKey)
            .first()
        )
          throw new Error('IDEMPOTENCY_CONFLICT');
        return null;
      }
      if (row.request_hash !== requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
      if (!(await authority.first())) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
      return { id: row.id, status: row.status };
    };
    const previous = await receipt();
    if (previous) return previous;
    if (input.tuple.workflowRevision !== this.config.workflowRevision)
      throw new Error('PUBLICATION_RUNTIME_UNAVAILABLE');
    const acceptance = await new D1ApprovalService(this.database).getLatestForJob(
      input.stagingJobId,
    );
    if (
      !acceptance ||
      acceptance.id !== input.approvalId ||
      acceptance.decision !== 'approved' ||
      JSON.stringify(acceptance.tuple) !== JSON.stringify(input.tuple)
    )
      throw new Error('PRODUCTION_ACCEPTANCE_CHANGED');
    const evidence = PublicationEvidenceSchema.parse(acceptance.evidence);
    const source = await this.database
      .prepare(
        `SELECT j.candidate_json,j.evidence_json,pr.build_json,
      pr.run_id,pr.check_run_id,pr.dispatch_revision,pi.workflow_revision
      FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id
      JOIN publication_runs pr ON pr.job_id=j.id JOIN drafts d ON d.id=pi.draft_id
      WHERE j.id=? AND j.environment='staging' AND j.status='succeeded' AND d.status='active'
        AND j.result_sha=? AND j.candidate_checksum=? AND pi.revision_id=?`,
      )
      .bind(
        input.stagingJobId,
        input.tuple.stagingCommitSha,
        input.tuple.candidateChecksum,
        input.tuple.revisionId,
      )
      .first<{
        candidate_json: string;
        evidence_json: string;
        build_json: string;
        run_id: string;
        check_run_id: string;
        dispatch_revision: string;
        workflow_revision: string;
      }>();
    if (!source) throw new Error('PRODUCTION_INPUTS_UNAVAILABLE');
    const build = PublicationBuildSchema.parse(JSON.parse(source.build_json));
    if (
      JSON.stringify(PublicationEvidenceSchema.parse(JSON.parse(source.evidence_json))) !==
        JSON.stringify(evidence) ||
      !evidence.workerVersionId ||
      evidence.runId !== source.run_id ||
      evidence.checkRunId !== source.check_run_id ||
      evidence.dispatchRevision !== source.dispatch_revision ||
      evidence.workflowRevision !== source.workflow_revision ||
      evidence.workflowRevision !== input.tuple.workflowRevision ||
      evidence.commitSha !== input.tuple.stagingCommitSha ||
      evidence.artifactDigest !== input.tuple.artifactDigest ||
      evidence.candidateChecksum !== input.tuple.candidateChecksum ||
      build.artifactDigest !== input.tuple.artifactDigest ||
      build.commitSha !== input.tuple.stagingCommitSha ||
      build.candidateChecksum !== input.tuple.candidateChecksum
    )
      throw new Error('PRODUCTION_INPUTS_UNAVAILABLE');
    const request: typeof fetch = (url, init) =>
      this.fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    await this.verifyDestination(
      input.tuple.productionBaseSha,
      input.actor,
      account.github_login,
      request,
    );
    const live = await verifyDeploymentProof(
      {
        target: 'staging',
        runId: evidence.runId,
        checkRunId: evidence.checkRunId,
        dispatchRevision: evidence.dispatchRevision,
        commitSha: evidence.commitSha,
        workflowRevision: evidence.workflowRevision,
        candidateChecksum: evidence.candidateChecksum,
        artifactDigest: evidence.artifactDigest,
        workerVersionId: evidence.workerVersionId,
        ...(evidence.verification ? { verification: evidence.verification } : {}),
      },
      request,
    );
    if (live.deploymentId !== evidence.deploymentId)
      throw new Error('PRODUCTION_ACCEPTANCE_CHANGED');
    const id = crypto.randomUUID();
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    try {
      await this.database.batch([
        this.database
          .prepare(
            `SELECT json(CASE WHEN EXISTS (
          SELECT 1 FROM user_roles u JOIN publish_jobs j ON j.id=? JOIN publication_runs pr ON pr.job_id=j.id
          JOIN publication_inputs pi ON pi.job_id=j.id JOIN drafts d ON d.id=pi.draft_id
          WHERE u.email=? AND u.active=1 AND u.role='administrator' AND u.github_login=? AND d.status='active'
            AND j.status='succeeded' AND j.candidate_json=? AND j.evidence_json=? AND pr.build_json=?
            AND (SELECT id FROM approvals WHERE gate='staging-acceptance' AND publish_job_id=j.id
              ORDER BY created_at DESC,rowid DESC LIMIT 1)=?
        ) AND NOT EXISTS(SELECT 1 FROM publication_slots WHERE target='production')
          AND NOT EXISTS(SELECT 1 FROM publish_jobs WHERE environment='production-merge' AND status IN ('queued','running'))
        THEN 'true' ELSE 'production capture changed' END)`,
          )
          .bind(
            input.stagingJobId,
            input.actor,
            account.github_login,
            source.candidate_json,
            source.evidence_json,
            source.build_json,
            input.approvalId,
          ),
        this.database
          .prepare(
            `INSERT INTO publish_jobs
          (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at)
          SELECT ?,?,'production-merge','queued',candidate_json,candidate_checksum,'PointCommunity/pointsite',?,?,
            strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM publish_jobs WHERE id=?`,
          )
          .bind(
            id,
            input.idempotencyKey,
            input.tuple.productionBaseSha,
            input.actor,
            input.stagingJobId,
          ),
        this.database
          .prepare(
            `INSERT INTO publication_inputs(job_id,draft_id,revision_id,workflow_revision)
          SELECT ?,draft_id,revision_id,workflow_revision FROM publication_inputs WHERE job_id=?`,
          )
          .bind(id, input.stagingJobId),
        this.database
          .prepare(
            `INSERT INTO publication_promotions(job_id,staging_job_id,approval_id,artifact_digest,request_hash)
          VALUES (?,?,?,?,?)`,
          )
          .bind(id, input.stagingJobId, input.approvalId, input.tuple.artifactDigest, requestHash),
        this.database
          .prepare(
            `INSERT INTO publication_asset_pins(job_id,draft_id,source_path,asset_id)
          SELECT ?,draft_id,source_path,asset_id FROM publication_asset_pins WHERE job_id=?`,
          )
          .bind(id, input.stagingJobId),
        this.database
          .prepare("INSERT INTO publication_slots(target,job_id) VALUES ('production',?)")
          .bind(id),
        this.database
          .prepare('INSERT INTO publication_runs(job_id,nonce,dispatch_revision) VALUES (?,?,?)')
          .bind(id, nonce, input.tuple.productionBaseSha),
        this.database
          .prepare(
            `INSERT INTO audit_events
          (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
          VALUES (?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,'publish.production-captured','publish-job',?,'succeeded',?,?)`,
          )
          .bind(
            crypto.randomUUID(),
            input.actor,
            id,
            input.requestId,
            JSON.stringify({ stagingJobId: input.stagingJobId, approvalId: input.approvalId }),
          ),
      ]);
    } catch {
      const committed = await receipt();
      if (committed) return committed;
      throw new Error('PRODUCTION_CAPTURE_CHANGED');
    }
    return { id, status: 'queued' };
  }
}
