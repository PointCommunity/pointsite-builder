import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { checksumDocument } from '../../site-kit/canonicalize';
import { createPublisherToken, githubHeaders } from '../github/app-auth';
import { PublicationBuildSchema, publicationJson } from './build-proof';
import { verifyStagingDeployment } from './deployment-proof';
import { verifyTerminalRun } from './recovery';
import { verifyPublicationRunner, type PublicationRunnerScope } from './runner-auth';
import type { PublisherConfig } from './service';

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
  nonce: string;
  workflow_revision: string;
  source_json: string;
  status: string;
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

  private async authenticate(id: string, token: string) {
    if (!z.uuid().safeParse(id).success) throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
    const row = await this.database
      .prepare(`SELECT v.* ${verificationFrom}`)
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
    claim = false,
  ) {
    const { row, scope, identity } = context;
    return this.database
      .prepare(
        `SELECT json(CASE WHEN EXISTS(SELECT 1 ${verificationFrom}
      AND v.nonce=? AND v.workflow_revision=? AND v.source_json=? AND v.reserved_run_id=? AND v.reserved_run_attempt=?
      AND v.reserved_check_run_id!=? AND (v.check_run_id=? ${claim ? 'OR v.check_run_id IS NULL' : ''})
      ${claim ? '' : "AND v.status='running'"}
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
      this.guard(context, true),
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
