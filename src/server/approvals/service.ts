import { z } from 'zod';

const Sha40 = z.string().regex(/^[a-f0-9]{40}$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const CandidateTupleSchema = z.strictObject({
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

export type CandidateTuple = z.infer<typeof CandidateTupleSchema>;
export type ApprovalDecision = 'approved' | 'rejected' | 'revoked';

export const VerificationEvidenceSchema = z.strictObject({
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
  constructor(private readonly database: D1Database) {}

  async record(input: {
    publishJobId: string;
    expectedTuple: CandidateTuple;
    decision: ApprovalDecision;
    note?: string;
    actor: string;
    requestId: string;
    idempotencyKey: string;
  }): Promise<ApprovalRecord> {
    const expected = CandidateTupleSchema.parse(input.expectedTuple);
    if (input.idempotencyKey.length < 16 || input.idempotencyKey.length > 100)
      throw new Error('IDEMPOTENCY_KEY_INVALID');
    if (input.note && input.note.length > 500) throw new Error('APPROVAL_NOTE_INVALID');

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

    const evidence = VerificationEvidenceSchema.safeParse(parseJson(job.evidence_json));
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

  async eligibility(tuple: CandidateTuple, observedProductionBaseSha: string) {
    const expected = CandidateTupleSchema.parse(tuple);
    Sha40.parse(observedProductionBaseSha);
    const row = await this.database
      .prepare(
        "SELECT id,publish_job_id,candidate_json,evidence_json,candidate_checksum,staging_commit_sha,production_base_sha,decision,actor,note,created_at FROM approvals WHERE gate='staging-acceptance' AND candidate_checksum=? ORDER BY created_at DESC,id DESC LIMIT 1",
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
