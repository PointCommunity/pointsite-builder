import { z } from 'zod';
import { PublicationEvidenceSchema, verifyDeploymentProof } from '../publish/deployment-proof';
import { publicationDestination } from '../publish/destinations';
import { PublicationBuildSchema, publicationJson } from '../publish/build-proof';
import { createPublisherToken } from '../github/app-auth';
import type { PublisherConfig } from '../publish/service';
import { checksumDocument } from '../../site-kit/canonicalize';

const Sha40 = z.string().regex(/^[a-f0-9]{40}$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const LegacyCandidateTupleSchema = z.strictObject({
  siteId: z.literal('pointsite'),
  revisionId: z.uuid(),
  revisionChecksum: Sha256,
  schemaVersion: z.number().int().positive(),
  rendererVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  candidateChecksum: Sha256,
  stagingBaseSha: Sha40,
  stagingCommitSha: Sha40,
  productionBaseSha: Sha40,
});

export const CloudCandidateTupleSchema = LegacyCandidateTupleSchema.extend({
  publicationProtocol: z.literal(2),
  workflowRevision: Sha40,
  artifactDigest: Sha256,
});
export const CandidateTupleSchema = z.union([
  CloudCandidateTupleSchema,
  LegacyCandidateTupleSchema,
]);

export type CandidateTuple = z.infer<typeof CandidateTupleSchema>;
export type ApprovalDecision = 'approved' | 'rejected' | 'revoked';

const LegacyVerificationEvidenceSchema = z.strictObject({
  verificationStatus: z.literal('passed').optional(),
  candidateChecksum: Sha256,
  commitSha: Sha40,
  workflowRunId: z.string().min(1).max(100),
  workflowUrl: z.url(),
  deploymentId: z.string().min(1).max(100),
  deploymentUrl: z.url(),
  checks: z.strictObject({
    build: z.literal(true),
    schema: z.literal(true),
    renderer: z.literal(true),
    routes: z.literal(true),
    assets: z.literal(true),
    accessibility: z.literal(true),
    responsive: z.literal(true),
    security: z.literal(true),
    primaryFlow: z.literal(true),
    live: z.literal(true),
  }),
});

export const VerificationEvidenceSchema = z.union([
  PublicationEvidenceSchema,
  LegacyVerificationEvidenceSchema,
]);

type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;

interface JobRow {
  id: string;
  status: string;
  candidate_checksum: string;
  candidate_json: string;
  base_sha: string;
  result_sha: string | null;
  evidence_json: string;
}

interface ApprovalRow {
  id: string;
  publish_job_id: string | null;
  candidate_json: string | null;
  evidence_json: string | null;
  candidate_checksum: string;
  staging_commit_sha: string | null;
  production_base_sha: string | null;
  decision: ApprovalDecision;
  actor: string;
  note: string | null;
  created_at: string;
}

export interface ApprovalRecord {
  id: string;
  publishJobId: string;
  tuple: CandidateTuple;
  evidence: VerificationEvidence;
  decision: ApprovalDecision;
  actor: string;
  note: string | null;
  createdAt: string;
}

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('APPROVAL_EVIDENCE_INCOMPLETE');
  }
};

const sameTuple = (left: CandidateTuple, right: CandidateTuple) =>
  JSON.stringify(left) === JSON.stringify(right);

const fromRow = (row: ApprovalRow): ApprovalRecord => {
  const tuple = CandidateTupleSchema.parse(parseJson(row.candidate_json ?? 'null'));
  const evidence = VerificationEvidenceSchema.parse(parseJson(row.evidence_json ?? 'null'));
  if (!row.publish_job_id) throw new Error('APPROVAL_RECORD_INVALID');
  return {
    id: row.id,
    publishJobId: row.publish_job_id,
    tuple,
    evidence,
    decision: row.decision,
    actor: row.actor,
    note: row.note,
    createdAt: row.created_at,
  };
};

export class D1ApprovalService {
  constructor(
    private readonly database: D1Database,
    private readonly config?: PublisherConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getLatestForJob(publishJobId: string): Promise<ApprovalRecord | null> {
    const row = await this.database
      .prepare(
        "SELECT id,publish_job_id,candidate_json,evidence_json,candidate_checksum,staging_commit_sha,production_base_sha,decision,actor,note,created_at FROM approvals WHERE gate='staging-acceptance' AND publish_job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .bind(publishJobId)
      .first<ApprovalRow>();
    return row ? fromRow(row) : null;
  }

  async record(input: {
    publishJobId: string;
    expectedTuple: CandidateTuple;
    decision: ApprovalDecision;
    note?: string;
    actor: string;
    requestId: string;
    idempotencyKey: string;
    expectedApprovalId?: string | null;
  }): Promise<ApprovalRecord> {
    const expected = CandidateTupleSchema.parse(input.expectedTuple);
    if (input.idempotencyKey.length < 16 || input.idempotencyKey.length > 100)
      throw new Error('IDEMPOTENCY_KEY_INVALID');
    if (input.note && input.note.length > 500) throw new Error('APPROVAL_NOTE_INVALID');
    if ('publicationProtocol' in expected) return this.recordCloud(input, expected);
    if (this.config) throw new Error('APPROVAL_CLOUD_CANDIDATE_REQUIRED');

    const previous = await this.database
      .prepare(
        'SELECT id,publish_job_id,candidate_json,evidence_json,candidate_checksum,staging_commit_sha,production_base_sha,decision,actor,note,created_at FROM approvals WHERE idempotency_key=?',
      )
      .bind(input.idempotencyKey)
      .first<ApprovalRow>();
    if (previous) {
      const result = fromRow(previous);
      if (
        result.publishJobId !== input.publishJobId ||
        result.decision !== input.decision ||
        !sameTuple(result.tuple, expected) ||
        result.note !== (input.note ?? null)
      )
        throw new Error('IDEMPOTENCY_CONFLICT');
      return result;
    }

    const job = await this.database
      .prepare(
        "SELECT id,status,candidate_checksum,candidate_json,base_sha,result_sha,evidence_json FROM publish_jobs WHERE id=? AND environment='staging'",
      )
      .bind(input.publishJobId)
      .first<JobRow>();
    if (!job || job.status !== 'succeeded' || !job.result_sha)
      throw new Error('APPROVAL_JOB_NOT_SUCCEEDED');

    const candidate = z
      .strictObject({
        siteId: z.literal('pointsite'),
        draftId: z.uuid().optional(),
        revisionId: z.uuid(),
        revisionChecksum: Sha256,
        schemaVersion: z.number().int().positive(),
        rendererVersion: z.string(),
        fileCount: z.number().int().positive().optional(),
      })
      .safeParse(parseJson(job.candidate_json));
    const actual: CandidateTuple | null = candidate.success
      ? {
          siteId: candidate.data.siteId,
          revisionId: candidate.data.revisionId,
          revisionChecksum: candidate.data.revisionChecksum,
          schemaVersion: candidate.data.schemaVersion,
          rendererVersion: candidate.data.rendererVersion,
          candidateChecksum: job.candidate_checksum,
          stagingBaseSha: job.base_sha,
          stagingCommitSha: job.result_sha,
          productionBaseSha: expected.productionBaseSha,
        }
      : null;
    if (!actual || !sameTuple(actual, expected)) throw new Error('APPROVAL_TUPLE_MISMATCH');

    const evidence = LegacyVerificationEvidenceSchema.safeParse(parseJson(job.evidence_json));
    if (
      !evidence.success ||
      evidence.data.candidateChecksum !== actual.candidateChecksum ||
      evidence.data.commitSha !== actual.stagingCommitSha
    )
      throw new Error('APPROVAL_EVIDENCE_INCOMPLETE');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO approvals (id,gate,candidate_checksum,decision,actor,note,created_at,idempotency_key,publish_job_id,candidate_json,evidence_json,staging_commit_sha,production_base_sha) VALUES (?,'staging-acceptance',?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          actual.candidateChecksum,
          input.decision,
          input.actor,
          input.note ?? null,
          now,
          input.idempotencyKey,
          job.id,
          JSON.stringify(actual),
          JSON.stringify(evidence.data),
          actual.stagingCommitSha,
          actual.productionBaseSha,
        ),
      this.database
        .prepare(
          "INSERT INTO audit_events (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json) VALUES (?,?,?,?,? ,?,'succeeded',?,?)",
        )
        .bind(
          crypto.randomUUID(),
          now,
          input.actor,
          `approval.${input.decision}`,
          'approval',
          id,
          input.requestId,
          JSON.stringify({
            publishJobId: job.id,
            candidateChecksum: actual.candidateChecksum,
            stagingCommitSha: actual.stagingCommitSha,
            productionBaseSha: actual.productionBaseSha,
          }),
        ),
    ]);
    return {
      id,
      publishJobId: job.id,
      tuple: actual,
      evidence: evidence.data,
      decision: input.decision,
      actor: input.actor,
      note: input.note ?? null,
      createdAt: now,
    };
  }

  private async recordCloud(
    input: {
      publishJobId: string;
      decision: ApprovalDecision;
      note?: string;
      actor: string;
      requestId: string;
      idempotencyKey: string;
      expectedApprovalId?: string | null;
    },
    expected: z.infer<typeof CloudCandidateTupleSchema>,
  ): Promise<ApprovalRecord> {
    if (!this.config) throw new Error('APPROVALS_NOT_CONFIGURED');
    z.uuid().parse(input.publishJobId);
    if (input.expectedApprovalId === undefined) throw new Error('APPROVAL_STATE_CHANGED');
    if (input.expectedApprovalId !== null) z.uuid().parse(input.expectedApprovalId);
    const authority = this.database
      .prepare(
        `SELECT github_login FROM user_roles WHERE email=?
      AND active=1 AND role IN ('publisher','administrator')`,
      )
      .bind(input.actor);
    const account = await authority.first<{ github_login: string }>();
    if (!account) throw new Error('APPROVAL_AUTHORITY_CHANGED');
    const requestHash = await checksumDocument({
      publishJobId: input.publishJobId,
      tuple: expected,
      decision: input.decision,
      note: input.note ?? null,
      actor: input.actor,
      previous: input.expectedApprovalId,
    });
    const receipt = async () => {
      const row = await this.database
        .prepare(
          `SELECT id,publish_job_id,candidate_json,evidence_json,candidate_checksum,
        staging_commit_sha,production_base_sha,decision,actor,note,created_at,request_hash FROM approvals WHERE idempotency_key=?`,
        )
        .bind(input.idempotencyKey)
        .first<ApprovalRow & { request_hash: string | null }>();
      if (!row) return null;
      if (row.request_hash !== requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
      if (!(await authority.first())) throw new Error('APPROVAL_AUTHORITY_CHANGED');
      return fromRow(row);
    };
    const previous = await receipt();
    if (previous) return previous;
    const row = await this.database
      .prepare(
        `SELECT j.id,j.status,j.candidate_json,j.candidate_checksum,j.base_sha,j.result_sha,j.evidence_json,
      pr.build_json,pr.run_id,pr.check_run_id,pr.dispatch_revision,pi.workflow_revision
      FROM publish_jobs j JOIN publication_inputs pi ON pi.job_id=j.id JOIN publication_runs pr ON pr.job_id=j.id
      WHERE j.id=? AND j.environment='staging'
        AND j.repository='PointCommunity/${publicationDestination('staging', this.config?.builderOrigin).repository}'`,
      )
      .bind(input.publishJobId)
      .first<
        JobRow & {
          build_json: string | null;
          run_id: string;
          check_run_id: string;
          dispatch_revision: string;
          workflow_revision: string;
        }
      >();
    if (!row || row.status !== 'succeeded' || !row.result_sha)
      throw new Error('APPROVAL_JOB_NOT_SUCCEEDED');
    const candidate = z
      .object({
        siteId: z.literal('pointsite'),
        revisionId: z.uuid(),
        revisionChecksum: Sha256,
        schemaVersion: z.number().int().positive(),
        rendererVersion: z.string(),
        publicationProtocol: z.literal(2),
        workflowRevision: Sha40,
      })
      .parse(parseJson(row.candidate_json));
    const build = PublicationBuildSchema.parse(parseJson(row.build_json ?? 'null'));
    const actual = CloudCandidateTupleSchema.parse({
      ...candidate,
      candidateChecksum: row.candidate_checksum,
      stagingBaseSha: row.base_sha,
      stagingCommitSha: row.result_sha,
      productionBaseSha: expected.productionBaseSha,
      artifactDigest: build.artifactDigest,
    });
    if (!sameTuple(actual, expected)) throw new Error('APPROVAL_TUPLE_MISMATCH');
    const proof = PublicationEvidenceSchema.safeParse(parseJson(row.evidence_json));
    if (
      !proof.success ||
      proof.data.runId !== row.run_id ||
      proof.data.checkRunId !== row.check_run_id ||
      proof.data.dispatchRevision !== row.dispatch_revision ||
      proof.data.workflowRevision !== row.workflow_revision ||
      proof.data.workflowRevision !== actual.workflowRevision ||
      proof.data.candidateChecksum !== actual.candidateChecksum ||
      proof.data.commitSha !== actual.stagingCommitSha ||
      proof.data.artifactDigest !== actual.artifactDigest ||
      build.candidateChecksum !== actual.candidateChecksum ||
      build.commitSha !== actual.stagingCommitSha
    )
      throw new Error('APPROVAL_EVIDENCE_INCOMPLETE');
    const latest = await this.getLatestForJob(row.id);
    if ((latest?.id ?? null) !== input.expectedApprovalId) {
      const committed = await receipt();
      if (committed) return committed;
      throw new Error('APPROVAL_STATE_CHANGED');
    }
    if (input.decision === 'revoked' && latest && !sameTuple(latest.tuple, expected))
      throw new Error('APPROVAL_TUPLE_MISMATCH');
    const request: typeof fetch = (url, init) =>
      this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const token = await createPublisherToken({
      ...this.config,
      repository: publicationDestination('staging', this.config.builderOrigin).repository,
      subject: input.actor,
      login: account.github_login,
      fetcher: request,
    });
    if (input.decision === 'approved') {
      const live = await verifyDeploymentProof(
        {
          target: 'staging',
          runId: proof.data.runId,
          checkRunId: proof.data.checkRunId,
          dispatchRevision: proof.data.dispatchRevision,
          commitSha: actual.stagingCommitSha,
          workflowRevision: actual.workflowRevision,
          candidateChecksum: actual.candidateChecksum,
          artifactDigest: actual.artifactDigest,
          workerVersionId: proof.data.workerVersionId,
          ...(proof.data.verification ? { verification: proof.data.verification } : {}),
        },
        request,
        token,
        this.config.builderOrigin,
      );
      if (
        live.deploymentId !== proof.data.deploymentId ||
        live.jobUrl !== proof.data.jobUrl ||
        live.deploymentUrl !== proof.data.deploymentUrl
      )
        throw new Error('STAGING_CANDIDATE_DRIFT');
      const production = await request(
        `https://api.github.com/repos/PointCommunity/${publicationDestination('production', this.config.builderOrigin).repository}/git/ref/heads/main`,
        { headers: { 'user-agent': 'PointSite-Builder', accept: 'application/vnd.github+json' } },
      );
      if (!production.ok) throw new Error('PRODUCTION_BASE_UNAVAILABLE');
      const base = z
        .object({ object: z.object({ sha: Sha40 }) })
        .parse(await publicationJson(production, 8192));
      if (base.object.sha !== actual.productionBaseSha) throw new Error('PRODUCTION_BASE_DRIFT');
    }
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    const guard = this.database
      .prepare(
        `SELECT json(CASE WHEN EXISTS (
      SELECT 1 FROM publish_jobs j JOIN publication_runs pr ON pr.job_id=j.id JOIN user_roles u ON u.email=?
      WHERE j.id=? AND j.status='succeeded' AND j.candidate_json=? AND j.evidence_json=? AND pr.build_json=?
        AND u.active=1 AND u.role IN ('publisher','administrator') AND u.github_login=?
        AND COALESCE((SELECT id FROM approvals WHERE gate='staging-acceptance' AND publish_job_id=j.id
          ORDER BY created_at DESC,rowid DESC LIMIT 1),'')=?
        AND (?!='approved' OR (NOT EXISTS(SELECT 1 FROM publication_slots WHERE target='staging' AND job_id!=j.id)
          AND NOT EXISTS(SELECT 1 FROM publish_jobs other WHERE other.environment='staging'
            AND other.id!=j.id AND other.status IN ('queued','running'))))
    ) THEN 'true' ELSE 'cloud acceptance changed' END)`,
      )
      .bind(
        input.actor,
        row.id,
        row.candidate_json,
        row.evidence_json,
        row.build_json,
        account.github_login,
        input.expectedApprovalId ?? '',
        input.decision,
      );
    try {
      await this.database.batch([
        guard,
        this.database
          .prepare(
            `INSERT INTO approvals(id,gate,candidate_checksum,decision,actor,note,created_at,idempotency_key,
        publish_job_id,candidate_json,evidence_json,staging_commit_sha,production_base_sha,request_hash)
        VALUES (?,'staging-acceptance',?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            id,
            actual.candidateChecksum,
            input.decision,
            input.actor,
            input.note ?? null,
            now,
            input.idempotencyKey,
            row.id,
            JSON.stringify(actual),
            JSON.stringify(proof.data),
            actual.stagingCommitSha,
            actual.productionBaseSha,
            requestHash,
          ),
        this.database
          .prepare(
            `INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
        VALUES (?,?,?,?,'approval',?,'succeeded',?,?)`,
          )
          .bind(
            crypto.randomUUID(),
            now,
            input.actor,
            `approval.${input.decision}`,
            id,
            input.requestId,
            JSON.stringify({
              publishJobId: row.id,
              candidateChecksum: actual.candidateChecksum,
              artifactDigest: actual.artifactDigest,
            }),
          ),
        this.database
          .prepare("DELETE FROM publication_slots WHERE target='staging' AND job_id=?")
          .bind(row.id),
      ]);
    } catch {
      const committed = await receipt();
      if (committed) return committed;
      throw new Error('APPROVAL_STATE_CHANGED');
    }
    return {
      id,
      publishJobId: row.id,
      tuple: actual,
      evidence: proof.data,
      decision: input.decision,
      actor: input.actor,
      note: input.note ?? null,
      createdAt: now,
    };
  }

  async eligibility(tuple: CandidateTuple, observedProductionBaseSha: string) {
    const expected = CandidateTupleSchema.parse(tuple);
    Sha40.parse(observedProductionBaseSha);
    const row = await this.database
      .prepare(
        "SELECT id,publish_job_id,candidate_json,evidence_json,candidate_checksum,staging_commit_sha,production_base_sha,decision,actor,note,created_at FROM approvals WHERE gate='staging-acceptance' AND candidate_checksum=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .bind(expected.candidateChecksum)
      .first<ApprovalRow>();
    if (!row) return { eligible: false as const, reason: 'NO_APPROVAL' as const };
    const approval = fromRow(row);
    if (approval.decision !== 'approved')
      return { eligible: false as const, reason: 'NOT_APPROVED' as const, approvalId: approval.id };
    if (!sameTuple(approval.tuple, expected))
      return {
        eligible: false as const,
        reason: 'CANDIDATE_DRIFT' as const,
        approvalId: approval.id,
      };
    if (approval.tuple.productionBaseSha !== observedProductionBaseSha)
      return {
        eligible: false as const,
        reason: 'PRODUCTION_BASE_DRIFT' as const,
        approvalId: approval.id,
      };
    return { eligible: true as const, approvalId: approval.id, approval };
  }
}
