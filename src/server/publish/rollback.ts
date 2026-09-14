import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { checksumDocument } from '../../site-kit/canonicalize';
import { createPublisherToken, githubHeaders } from '../github/app-auth';
import { publicationJson } from './build-proof';
import { PublicationEvidenceSchema, verifyDeploymentProof } from './deployment-proof';
import { verifyTerminalRun } from './recovery';
import { rollbackSource, type RollbackSource } from './rollback-source';
import { verifyPublicationRunner } from './runner-auth';
import type { PublisherConfig } from './service';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const identifier = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const RollbackCaptureSchema = z.strictObject({
  sourceReleaseId: z.string().min(1).max(100),
  previousReleaseId: z.string().min(1).max(100),
  baseSha: sha,
  previousDeploymentId: identifier,
  replaceJobId: z.uuid().optional(),
  actor: z.string().regex(/^github:[1-9][0-9]*$/),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,100}$/),
  requestId: z.string().min(1).max(200),
});
const authorized = `FROM publication_rollbacks r JOIN user_roles u ON u.email=r.requested_by
  WHERE r.id=? AND u.active=1 AND u.role='administrator'`;
type RollbackRow = {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'cancelled';
  nonce: string;
  base_sha: string;
  previous_deployment_id: string;
  workflow_revision: string;
  requested_by: string;
  github_login: string;
  source_json: string;
  candidate_checksum: string;
  previous_release_id: string;
  reserved_run_id: string | null;
  reserved_run_attempt: string | null;
  reserved_check_run_id: string | null;
  check_run_id: string | null;
  deploy_authorized_at: string | null;
  reported_at: string | null;
  evidence_json: string;
  dispatch_count: number;
};
type Identity = Awaited<ReturnType<typeof verifyPublicationRunner>>;
const api = 'https://api.github.com/repos/PointCommunity/pointsite';

/** One global Production operation; source bytes are restored without rewriting Git history. */
export class D1CloudRollback {
  constructor(
    private readonly database: D1Database,
    private readonly config: PublisherConfig & { workflowRevision: string },
    private readonly callerBlob: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly keys?: JWTVerifyGetKey,
  ) {}

  private request: typeof fetch = (url, init) => {
    const fetcher = this.fetcher;
    return fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  };

  private authority(actor: string) {
    RollbackCaptureSchema.shape.actor.parse(actor);
    return this.database
      .prepare(
        "SELECT github_login FROM user_roles WHERE email=? AND active=1 AND role='administrator'",
      )
      .bind(actor);
  }

  private async publisher(actor: string, login: string) {
    return createPublisherToken({
      ...this.config,
      repository: 'pointsite',
      subject: actor,
      login,
      fetcher: this.request,
    });
  }

  private async nativeState(
    token: string,
    baseSha?: string,
    previousDeploymentId?: string,
    execution?: { runId: string; checkRunId: string },
  ) {
    try {
      sha.parse(this.callerBlob);
      const read = async (path: string) =>
        publicationJson(
          await this.request(`${api}${path}`, { headers: githubHeaders(token) }),
          32768,
        );
      const base = z.object({ object: z.object({ sha }) }).parse(await read('/git/ref/heads/main'))
        .object.sha;
      if (baseSha && base !== baseSha) throw new Error('Changed base');
      z.object({ type: z.literal('file'), sha: z.literal(this.callerBlob) }).parse(
        await read(`/contents/.github/workflows/rollback-production.yml?ref=${base}`),
      );
      const deployment = z.object({
        id: z.number().int().positive(),
        environment: z.literal('github-pages'),
        sha: sha.optional(),
        performed_via_github_app: z.object({
          id: z.literal(15368),
          slug: z.literal('github-actions'),
        }),
      });
      const deployments = z
        .array(deployment)
        .length(execution ? 2 : 1)
        .parse(await read(`/deployments?environment=github-pages&per_page=${execution ? 2 : 1}`));
      const latest = deployments[0];
      const previous = execution ? deployments[1] : latest;
      if (previousDeploymentId && String(previous.id) !== previousDeploymentId)
        throw new Error('Changed deployment');
      const [status] = z
        .array(
          z.object({
            state: z.string(),
            environment: z.literal('github-pages'),
            log_url: z.string(),
          }),
        )
        .length(1)
        .parse(await read(`/deployments/${latest.id}/statuses?per_page=1`));
      if (execution) {
        if (
          latest.sha !== base ||
          !['queued', 'pending', 'in_progress'].includes(status.state) ||
          status.log_url !==
            `https://github.com/PointCommunity/pointsite/actions/runs/${execution.runId}/job/${execution.checkRunId}`
        )
          throw new Error('Changed execution');
      } else if (!['success', 'failure', 'error', 'inactive'].includes(status.state))
        throw new Error('Deployment still running');
      return { baseSha: base, previousDeploymentId: String(previous.id) };
    } catch {
      throw new Error('ROLLBACK_STATE_CHANGED');
    }
  }

  async capture(value: z.infer<typeof RollbackCaptureSchema>) {
    const input = RollbackCaptureSchema.parse(value);
    const { idempotencyKey, requestId, ...selection } = input;
    const requestHash = await checksumDocument(selection);
    const authority = this.authority(input.actor);
    const account = await authority.first<{ github_login: string }>();
    if (!account) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
    const receipt = async () => {
      const row = await this.database
        .prepare('SELECT id,status,request_hash FROM publication_rollbacks WHERE idempotency_key=?')
        .bind(idempotencyKey)
        .first<{ id: string; status: string; request_hash: string }>();
      if (row && row.request_hash !== requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
      if (
        !row &&
        (await this.database
          .prepare('SELECT 1 FROM publication_tombstones WHERE idempotency_key=?')
          .bind(idempotencyKey)
          .first())
      )
        throw new Error('IDEMPOTENCY_CONFLICT');
      if (!(await authority.first())) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
      return row ? { id: row.id, status: row.status } : null;
    };
    const previous = await receipt();
    if (previous) return previous;
    const release = await this.database
      .prepare('SELECT kind,artifact_digest,source_json FROM publication_releases WHERE id=?')
      .bind(input.sourceReleaseId)
      .first<{ kind: string; artifact_digest: string; source_json: string }>();
    if (!release) throw new Error('ROLLBACK_SOURCE_UNAVAILABLE');
    const source = rollbackSource(release);
    await this.nativeState(
      await this.publisher(input.actor, account.github_login),
      input.baseSha,
      input.previousDeploymentId,
    );
    const replace = input.replaceJobId
      ? await this.database
          .prepare(
            `SELECT pr.reserved_run_id AS run_id,
      pr.reserved_run_attempt AS run_attempt,pr.dispatch_revision,pi.workflow_revision
      FROM publication_slots ps JOIN publish_jobs j ON j.id=ps.job_id JOIN publication_runs pr ON pr.job_id=j.id
      JOIN publication_inputs pi ON pi.job_id=j.id WHERE j.id=? AND ps.target='production'
      AND j.environment='production-merge' AND j.status IN ('queued','running','failed')
      AND pr.reserved_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM publication_verifications WHERE job_id=j.id)`,
          )
          .bind(input.replaceJobId)
          .first()
      : null;
    if (input.replaceJobId && !replace) throw new Error('ROLLBACK_CAPTURE_CHANGED');
    if (replace) await verifyTerminalRun({ ...replace, target: 'production' }, this.request);
    const id = crypto.randomUUID();
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const candidateChecksum = await checksumDocument({
      id,
      ...selection,
      source,
      workflowRevision: this.config.workflowRevision,
    });
    try {
      await this.database.batch([
        this.database
          .prepare(
            `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM user_roles WHERE email=? AND active=1
          AND role='administrator' AND github_login=?) AND EXISTS(SELECT 1 FROM publication_releases WHERE id=?
          AND kind=? AND artifact_digest=? AND source_json=?) THEN 'true' ELSE 'rollback capture changed' END)`,
          )
          .bind(
            input.actor,
            account.github_login,
            input.sourceReleaseId,
            release.kind,
            release.artifact_digest,
            release.source_json,
          ),
        ...(replace
          ? [
              this.database
                .prepare(
                  `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM publication_slots ps
            JOIN publication_runs pr ON pr.job_id=ps.job_id WHERE ps.target='production' AND ps.job_id=?
            AND pr.reserved_run_id=? AND pr.reserved_run_attempt=?
            AND NOT EXISTS(SELECT 1 FROM publication_verifications WHERE job_id=ps.job_id))
            THEN 'true' ELSE 'rollback replacement changed' END)`,
                )
                .bind(input.replaceJobId!, replace.run_id, replace.run_attempt),
              this.database
                .prepare(
                  `UPDATE publish_jobs SET status='cancelled',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            evidence_json=json_set(evidence_json,'$.failureCode','REPLACED_BY_ROLLBACK') WHERE id=?`,
                )
                .bind(input.replaceJobId!),
              this.database
                .prepare("DELETE FROM publication_slots WHERE target='production' AND job_id=?")
                .bind(input.replaceJobId!),
            ]
          : []),
        this.database
          .prepare(
            `INSERT INTO publication_rollbacks(id,idempotency_key,request_hash,source_release_id,
          previous_release_id,source_json,candidate_checksum,base_sha,previous_deployment_id,workflow_revision,requested_by,nonce)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            id,
            idempotencyKey,
            requestHash,
            input.sourceReleaseId,
            input.previousReleaseId,
            JSON.stringify(source),
            candidateChecksum,
            input.baseSha,
            input.previousDeploymentId,
            this.config.workflowRevision,
            input.actor,
            nonce,
          ),
        this.audit(id, input.actor, 'rollback.captured', requestId),
      ]);
    } catch {
      const committed = await receipt();
      if (committed) return committed;
      throw new Error('ROLLBACK_CAPTURE_CHANGED');
    }
    return { id, status: 'queued' };
  }

  async workflow(actor: string) {
    const authority = this.authority(actor);
    const account = await authority.first<{ github_login: string }>();
    if (!account) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
    const releases = await this.database
      .prepare(
        `SELECT id,kind,verified_at AS verifiedAt,artifact_digest AS artifactDigest
      FROM publication_releases ORDER BY sequence DESC LIMIT 20`,
      )
      .all<{
        id: string;
        kind: string;
        verifiedAt: string;
        artifactDigest: string;
      }>();
    const job = await this.database
      .prepare(
        `SELECT id,status,source_release_id AS sourceReleaseId,requested_at AS requestedAt,
      dispatch_count AS attempts,reserved_run_id AS runId,reported_at AS reportedAt,evidence_json AS evidenceJson
      FROM publication_rollbacks ORDER BY rowid DESC LIMIT 1`,
      )
      .first<{
        id: string;
        status: RollbackRow['status'];
        sourceReleaseId: string;
        requestedAt: string;
        attempts: number;
        runId: string | null;
        reportedAt: string | null;
        evidenceJson: string;
      }>();
    const publication = await this.database
      .prepare("SELECT job_id FROM publication_slots WHERE target='production'")
      .first<string>('job_id');
    // Routine polling stays database-only. Native selection is read on explicit prepare.
    if (!(await authority.first())) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
    return {
      releases: releases.results,
      job: job
        ? {
            id: job.id,
            status: job.status,
            sourceReleaseId: job.sourceReleaseId,
            requestedAt: job.requestedAt,
            attempts: job.attempts,
            canVerify: Boolean(job.reportedAt),
            workflowUrl: job.runId
              ? `https://github.com/PointCommunity/pointsite/actions/runs/${job.runId}`
              : null,
          }
        : null,
      publicationJobId: publication,
    };
  }

  async prepare(actor: string) {
    const account = await this.authority(actor).first<{ github_login: string }>();
    if (!account) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
    const state = await this.nativeState(await this.publisher(actor, account.github_login));
    const workflow = await this.workflow(actor);
    if (!workflow.releases.length) throw new Error('ROLLBACK_SOURCE_UNAVAILABLE');
    return {
      ...state,
      previousReleaseId: workflow.releases[0].id,
      ...(workflow.publicationJobId ? { replaceJobId: workflow.publicationJobId } : {}),
    };
  }

  /** A terminal native run can be reconciled or cancelled; cancellation never starts another deployment. */
  async recover(jobId: string, actor: string, action: 'cancel' | 'verify') {
    z.uuid().parse(jobId);
    z.enum(['cancel', 'verify']).parse(action);
    const authority = this.authority(actor);
    const account = await authority.first<{ github_login: string }>();
    if (!account) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
    const row = await this.database
      .prepare('SELECT * FROM publication_rollbacks WHERE id=?')
      .bind(jobId)
      .first<RollbackRow>();
    if (!row) throw new Error('ROLLBACK_RECOVERY_CHANGED');
    if (
      (action === 'cancel' && row.status === 'cancelled') ||
      (action === 'verify' && row.status === 'succeeded')
    )
      return { recovered: true as const };
    if (!['queued', 'running'].includes(row.status)) throw new Error('ROLLBACK_RECOVERY_CHANGED');
    const token = await this.publisher(actor, account.github_login);
    if (row.reserved_run_id)
      await verifyTerminalRun(
        {
          purpose: 'rollback',
          target: 'production',
          run_id: row.reserved_run_id,
          run_attempt: row.reserved_run_attempt,
          dispatch_revision: row.base_sha,
          workflow_revision: row.workflow_revision,
        },
        this.request,
        token,
      );
    const guard = this.database
      .prepare(
        `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM publication_rollbacks r
      JOIN user_roles u ON u.email=? WHERE r.id=? AND r.status=? AND r.reserved_run_id IS ?
      AND r.reserved_run_attempt IS ? AND r.dispatch_count=? AND u.active=1 AND u.role='administrator'
      AND u.github_login=?) THEN 'true' ELSE 'rollback recovery changed' END)`,
      )
      .bind(
        actor,
        jobId,
        row.status,
        row.reserved_run_id,
        row.reserved_run_attempt,
        row.dispatch_count,
        account.github_login,
      );
    if (action === 'verify') {
      // Verification retains the original actor; revocation cannot be bypassed by another session.
      const original = await this.authority(row.requested_by).first<{ github_login: string }>();
      if (!original) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
      await this.complete({ ...row, github_login: original.github_login }, guard);
    } else
      await this.database.batch([
        guard,
        this.database
          .prepare(
            "UPDATE publication_rollbacks SET status='cancelled',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
          )
          .bind(jobId),
        this.audit(jobId, actor, 'rollback.cancelled'),
      ]);
    return { recovered: true as const };
  }

  private audit(
    id: string,
    actor: string,
    action: string,
    requestId: string = crypto.randomUUID(),
  ) {
    return this.database
      .prepare(
        `INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
      VALUES (?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?,'publication-rollback',?,'succeeded',?,'{}')`,
      )
      .bind(crypto.randomUUID(), actor, action, id, requestId);
  }

  async dispatchPending() {
    const row = await this.database
      .prepare(
        `SELECT r.*,u.github_login FROM publication_rollbacks r
      JOIN user_roles u ON u.email=r.requested_by WHERE r.status='queued' AND r.reserved_run_id IS NULL
      AND r.dispatch_count<6 AND r.dispatch_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND u.active=1 AND u.role='administrator' LIMIT 1`,
      )
      .first<RollbackRow>();
    if (!row) return;
    const reserved = await this.database
      .prepare(
        `UPDATE publication_rollbacks
      SET dispatch_after=strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || (60 << dispatch_count) || ' seconds'),dispatch_count=dispatch_count+1
      WHERE id=? AND status='queued' AND reserved_run_id IS NULL AND dispatch_count=?
      AND dispatch_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .bind(row.id, row.dispatch_count)
      .run();
    if (!reserved.meta.changes) return;
    const token = await this.publisher(row.requested_by, row.github_login);
    await this.nativeState(token, row.base_sha, row.previous_deployment_id);
    if (
      !(await this.database
        .prepare(
          `SELECT 1 ${authorized} AND r.status='queued' AND r.reserved_run_id IS NULL
      AND u.github_login=?`,
        )
        .bind(row.id, row.github_login)
        .first())
    )
      throw new Error('ROLLBACK_DISPATCH_CHANGED');
    const response = await this.request(`${api}/dispatches`, {
      method: 'POST',
      headers: { ...githubHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        event_type: 'rollback-production',
        client_payload: {
          jobId: row.id,
          nonce: row.nonce,
          builderOrigin: this.config.builderOrigin ?? 'https://builder.pointatx.org',
        },
      }),
    });
    if (response.status !== 204) throw new Error('ROLLBACK_DISPATCH_UNCONFIRMED');
  }

  private async authenticate(jobId: string, token: string, completed = false) {
    z.uuid().parse(jobId);
    const row = await this.database
      .prepare(
        `SELECT r.*,u.github_login ${authorized}
      AND r.status IN (${completed ? "'running','succeeded'" : "'queued','running'"})`,
      )
      .bind(jobId)
      .first<RollbackRow>();
    if (!row) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    const identity = await verifyPublicationRunner(
      token,
      {
        builderOrigin: this.config.builderOrigin,
        target: 'production',
        purpose: 'rollback',
        jobId,
        nonce: row.nonce,
        dispatchRevision: row.base_sha,
        workflowRevision: row.workflow_revision,
        ...(row.reserved_run_id && row.reserved_run_attempt
          ? { run: { id: row.reserved_run_id, attempt: row.reserved_run_attempt } }
          : {}),
      },
      this.keys,
    );
    return { row, identity };
  }

  private guard(
    row: RollbackRow,
    identity: Identity,
    mode: 'claim' | 'execute' | 'finalize' = 'execute',
  ) {
    return this.database
      .prepare(
        `SELECT json(CASE WHEN EXISTS(SELECT 1 ${authorized}
      AND r.status IN (${mode === 'claim' ? "'queued','running'" : "'running'"})
      AND r.reserved_run_id=? AND r.reserved_run_attempt=? AND r.reserved_check_run_id!=?
      AND (${mode === 'claim' ? 'r.check_run_id IS NULL OR ' : ''}r.check_run_id${mode === 'finalize' ? '!=' : '='}?)
      AND u.github_login=? AND r.previous_release_id IS (SELECT id FROM publication_releases ORDER BY sequence DESC LIMIT 1)
      ) THEN 'true' ELSE 'rollback authority changed' END)`,
      )
      .bind(
        row.id,
        identity.runId,
        identity.runAttempt,
        identity.checkRunId,
        identity.checkRunId,
        row.github_login,
      );
  }

  async reserve(jobId: string, token: string) {
    const { row, identity } = await this.authenticate(jobId, token);
    await this.nativeState(
      await this.publisher(row.requested_by, row.github_login),
      row.base_sha,
      row.previous_deployment_id,
    );
    await this.database.batch([
      this.database
        .prepare(
          `SELECT json(CASE WHEN EXISTS(SELECT 1 ${authorized} AND r.status='queued' AND r.check_run_id IS NULL
        AND (r.reserved_run_id IS NULL OR (r.reserved_run_id=? AND r.reserved_run_attempt=? AND r.reserved_check_run_id=?)))
        THEN 'true' ELSE 'rollback reservation changed' END)`,
        )
        .bind(jobId, identity.runId, identity.runAttempt, identity.checkRunId),
      this.database
        .prepare(
          'UPDATE publication_rollbacks SET reserved_run_id=?,reserved_run_attempt=?,reserved_check_run_id=? WHERE id=?',
        )
        .bind(identity.runId, identity.runAttempt, identity.checkRunId, jobId),
    ]);
    return { reserved: true as const };
  }

  async claim(jobId: string, token: string) {
    const { row, identity } = await this.authenticate(jobId, token);
    await this.database.batch([
      this.guard(row, identity, 'claim'),
      this.database
        .prepare("UPDATE publication_rollbacks SET status='running',check_run_id=? WHERE id=?")
        .bind(identity.checkRunId, jobId),
    ]);
    return { claimed: true as const };
  }

  async inputs(jobId: string, token: string) {
    const { row, identity } = await this.authenticate(jobId, token);
    await this.guard(row, identity).first();
    return {
      source: JSON.parse(row.source_json) as RollbackSource,
      candidateChecksum: row.candidate_checksum,
      baseSha: row.base_sha,
      workflowRevision: row.workflow_revision,
    };
  }

  async authorizeDeployment(jobId: string, token: string) {
    const { row, identity } = await this.authenticate(jobId, token);
    await this.guard(row, identity).first();
    await this.nativeState(
      await this.publisher(row.requested_by, row.github_login),
      row.base_sha,
      row.previous_deployment_id,
      identity,
    );
    await this.database.batch([
      this.guard(row, identity),
      this.database
        .prepare(
          `UPDATE publication_rollbacks
      SET deploy_authorized_at=COALESCE(deploy_authorized_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`,
        )
        .bind(jobId),
    ]);
    return { authorized: true as const };
  }

  async reportDeployment(jobId: string, token: string, value: unknown) {
    const { row, identity } = await this.authenticate(jobId, token);
    const source = rollbackSource({
      kind: 'rollback',
      artifact_digest: z.object({ artifactDigest: z.string() }).parse(JSON.parse(row.source_json))
        .artifactDigest,
      source_json: row.source_json,
    });
    z.strictObject({ artifactDigest: z.literal(source.artifactDigest) }).parse(value);
    if (!row.deploy_authorized_at) throw new Error('PUBLICATION_DEPLOYMENT_NOT_AUTHORIZED');
    await this.database.batch([
      this.guard(row, identity),
      this.database
        .prepare(
          `UPDATE publication_rollbacks
      SET reported_at=COALESCE(reported_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`,
        )
        .bind(jobId),
    ]);
    return { recorded: true as const };
  }

  private async complete(row: RollbackRow, guard: D1PreparedStatement) {
    if (!row.deploy_authorized_at || !row.reported_at || !row.check_run_id || !row.reserved_run_id)
      throw new Error('PUBLICATION_DEPLOYMENT_NOT_AUTHORIZED');
    const source = JSON.parse(row.source_json) as RollbackSource;
    const evidence = PublicationEvidenceSchema.parse({
      ...(await verifyDeploymentProof(
        {
          target: 'production',
          runId: row.reserved_run_id,
          checkRunId: row.check_run_id,
          dispatchRevision: row.base_sha,
          commitSha: row.base_sha,
          workflowRevision: row.workflow_revision,
          candidateChecksum: row.candidate_checksum,
          artifactDigest: source.artifactDigest,
        },
        this.request,
        await this.publisher(row.requested_by, row.github_login),
      )),
      verificationStatus: 'passed',
    });
    await this.database.batch([
      guard,
      this.database
        .prepare(
          `SELECT json(CASE WHEN EXISTS(SELECT 1 ${authorized} AND u.github_login=?
        AND r.previous_release_id IS (SELECT id FROM publication_releases ORDER BY sequence DESC LIMIT 1))
        THEN 'true' ELSE 'rollback completion changed' END)`,
        )
        .bind(row.id, row.github_login),
      this.database
        .prepare(
          `UPDATE publication_rollbacks SET status='succeeded',evidence_json=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        )
        .bind(JSON.stringify(evidence), row.id),
      this.database
        .prepare(
          `INSERT INTO publication_releases(id,kind,job_id,previous_release_id,artifact_digest,source_json,evidence_json,verified_at)
        SELECT id,'rollback',id,previous_release_id,json_extract(source_json,'$.artifactDigest'),source_json,evidence_json,completed_at
        FROM publication_rollbacks WHERE id=?`,
        )
        .bind(row.id),
      this.audit(row.id, row.requested_by, 'rollback.verified'),
    ]);
  }

  async finalize(jobId: string, token: string) {
    const { row, identity } = await this.authenticate(jobId, token, true);
    if (
      identity.checkRunId === row.check_run_id ||
      identity.checkRunId === row.reserved_check_run_id
    )
      throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    if (row.status !== 'succeeded') {
      try {
        await this.complete(row, this.guard(row, identity, 'finalize'));
      } catch (error) {
        const committed = await this.authenticate(jobId, token, true);
        if (committed.row.status !== 'succeeded') throw error;
      }
    }
    return { verified: true as const };
  }
}
