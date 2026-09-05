export type PublishJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface PublishJobRecord {
  id: string;
  idempotencyKey: string;
  status: PublishJobStatus;
  candidateChecksum: string;
  candidate: Record<string, string | number>;
  baseSha: string;
  resultSha: string | null;
  externalUrl: string | null;
  evidence: Record<string, string>;
  requestedBy: string;
  requestedAt: string;
  completedAt: string | null;
}

interface JobRow {
  id: string;
  idempotency_key: string;
  status: PublishJobStatus;
  candidate_checksum: string;
  candidate_json: string;
  base_sha: string;
  result_sha: string | null;
  external_url: string | null;
  evidence_json: string;
  requested_by: string;
  requested_at: string;
  completed_at: string | null;
}

const fromRow = (row: JobRow): PublishJobRecord => ({
  id: row.id,
  idempotencyKey: row.idempotency_key,
  status: row.status,
  candidateChecksum: row.candidate_checksum,
  candidate: JSON.parse(row.candidate_json) as Record<string, string | number>,
  baseSha: row.base_sha,
  resultSha: row.result_sha,
  externalUrl: row.external_url,
  evidence: JSON.parse(row.evidence_json) as Record<string, string>,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  completedAt: row.completed_at,
});

export class D1PublishJobStore {
  constructor(private readonly database: D1Database) {}

  async getByKey(key: string): Promise<PublishJobRecord | null> {
    const row = await this.database
      .prepare(
        'SELECT id,idempotency_key,status,candidate_checksum,candidate_json,base_sha,result_sha,external_url,evidence_json,requested_by,requested_at,completed_at FROM publish_jobs WHERE idempotency_key=?',
      )
      .bind(key)
      .first<JobRow>();
    return row ? fromRow(row) : null;
  }

  async create(input: {
    idempotencyKey: string;
    candidateChecksum: string;
    candidate: Record<string, string | number>;
    baseSha: string;
    actor: string;
    requestId: string;
  }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO publish_jobs (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at) VALUES (?,?,'staging','queued',?,?,'PointCommunity/pointsite-staging',?,?,?)",
        )
        .bind(
          id,
          input.idempotencyKey,
          JSON.stringify(input.candidate),
          input.candidateChecksum,
          input.baseSha,
          input.actor,
          now,
        ),
      this.audit(input.actor, 'publish.queued', id, input.requestId, {
        candidateChecksum: input.candidateChecksum,
        baseSha: input.baseSha,
      }),
    ]);
    const created = await this.getByKey(input.idempotencyKey);
    if (!created) throw new Error('PUBLISH_JOB_CREATE_FAILED');
    return created;
  }

  async markRunning(id: string, actor: string, requestId: string): Promise<void> {
    const update = await this.database
      .prepare(
        "UPDATE publish_jobs SET status='running',completed_at=NULL WHERE id=? AND status IN ('queued','failed')",
      )
      .bind(id)
      .run();
    if (!update.meta.changes) throw new Error('PUBLISH_JOB_NOT_CLAIMABLE');
    await this.audit(actor, 'publish.running', id, requestId, {}).run();
  }

  async succeed(
    id: string,
    actor: string,
    requestId: string,
    result: { sha: string; url: string },
  ): Promise<void> {
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE publish_jobs SET status='succeeded',result_sha=?,external_url=?,evidence_json=?,completed_at=? WHERE id=? AND status='running'",
        )
        .bind(
          result.sha,
          result.url,
          JSON.stringify({ commitSha: result.sha, commitUrl: result.url }),
          new Date().toISOString(),
          id,
        ),
      this.audit(actor, 'publish.succeeded', id, requestId, { commitSha: result.sha }),
    ]);
  }

  async fail(id: string, actor: string, requestId: string, code: string): Promise<void> {
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE publish_jobs SET status='failed',evidence_json=?,completed_at=? WHERE id=? AND status='running'",
        )
        .bind(JSON.stringify({ failureCode: code }), new Date().toISOString(), id),
      this.audit(actor, 'publish.failed', id, requestId, { failureCode: code }),
    ]);
  }

  private audit(
    actor: string,
    action: string,
    id: string,
    requestId: string,
    metadata: Record<string, string>,
  ) {
    return this.database
      .prepare(
        "INSERT INTO audit_events (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json) VALUES (?,?,?,?,?,?,'succeeded',?,?)",
      )
      .bind(
        crypto.randomUUID(),
        new Date().toISOString(),
        actor,
        action,
        'publish-job',
        id,
        requestId,
        JSON.stringify(metadata),
      );
  }
}
