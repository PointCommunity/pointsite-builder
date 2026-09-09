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
  evidence: Record<string, unknown>;
  requestedBy: string;
  requestedAt: string;
  completedAt: string | null;
  leaseExpiresAt: string | null;
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
  lease_expires_at?: string | null;
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
  evidence: JSON.parse(row.evidence_json) as Record<string, unknown>,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  completedAt: row.completed_at,
  leaseExpiresAt: row.lease_expires_at ?? null,
});

const selection =
  'id,idempotency_key,status,candidate_checksum,candidate_json,base_sha,result_sha,external_url,evidence_json,requested_by,requested_at,completed_at,lease_expires_at';

const leaseExpiry = (now: string) => new Date(Date.parse(now) + 15 * 60_000).toISOString();

export class D1PublishJobStore {
  constructor(private readonly database: D1Database) {}

  async getByKey(key: string): Promise<PublishJobRecord | null> {
    const row = await this.database
      .prepare(`SELECT ${selection} FROM publish_jobs WHERE idempotency_key=?`)
      .bind(key)
      .first<JobRow>();
    return row ? fromRow(row) : null;
  }

  async getById(id: string): Promise<PublishJobRecord | null> {
    const row = await this.database
      .prepare(`SELECT ${selection} FROM publish_jobs WHERE id=? AND environment='staging'`)
      .bind(id)
      .first<JobRow>();
    return row ? fromRow(row) : null;
  }

  async getLatestForDraft(draftId: string): Promise<PublishJobRecord | null> {
    const row = await this.database
      .prepare(
        `SELECT ${selection} FROM publish_jobs WHERE environment='staging' AND json_extract(candidate_json,'$.draftId')=? ORDER BY requested_at DESC,id DESC LIMIT 1`,
      )
      .bind(draftId)
      .first<JobRow>();
    return row ? fromRow(row) : null;
  }

  async getLatestReusable(
    candidateChecksum: string,
    baseSha: string,
  ): Promise<PublishJobRecord | null> {
    const row = await this.database
      .prepare(
        `SELECT ${selection} FROM publish_jobs WHERE environment='staging' AND candidate_checksum=? AND base_sha=? ORDER BY requested_at DESC,id DESC LIMIT 1`,
      )
      .bind(candidateChecksum, baseSha)
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
    now?: string;
  }) {
    const id = crypto.randomUUID();
    const now = input.now ?? new Date().toISOString();
    await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO publish_jobs (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at,lease_expires_at) VALUES (?,?,'staging','queued',?,?,'PointCommunity/pointsite-staging',?,?,?,?)",
        )
        .bind(
          id,
          input.idempotencyKey,
          JSON.stringify(input.candidate),
          input.candidateChecksum,
          input.baseSha,
          input.actor,
          now,
          leaseExpiry(now),
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

  async claim(input: {
    idempotencyKey: string;
    candidateChecksum: string;
    candidate: Record<string, string | number>;
    baseSha: string;
    actor: string;
    requestId: string;
    now?: string;
  }): Promise<PublishJobRecord> {
    const now = input.now ?? new Date().toISOString();
    const existing = await this.getByKey(input.idempotencyKey);
    if (existing?.status === 'succeeded') return existing;
    if (
      existing &&
      (existing.candidateChecksum !== input.candidateChecksum || existing.baseSha !== input.baseSha)
    )
      throw new Error('IDEMPOTENCY_CONFLICT');
    if (
      existing &&
      (existing.status === 'queued' || existing.status === 'running') &&
      existing.leaseExpiresAt &&
      existing.leaseExpiresAt > now
    )
      return existing;

    await this.recoverExpiredLease(now, input.actor, input.requestId);
    try {
      if (existing) {
        const update = await this.database
          .prepare(
            "UPDATE publish_jobs SET status='running',completed_at=NULL,lease_expires_at=? WHERE id=? AND status IN ('failed','cancelled')",
          )
          .bind(leaseExpiry(now), existing.id)
          .run();
        if (!update.meta.changes) throw new Error('PUBLISH_SLOT_BUSY');
        await this.audit(input.actor, 'publish.running', existing.id, input.requestId, {}).run();
        const reclaimed = await this.getById(existing.id);
        if (!reclaimed) throw new Error('PUBLISH_JOB_NOT_CLAIMABLE');
        return reclaimed;
      }
      const created = await this.create({ ...input, now });
      await this.markRunning(created.id, input.actor, input.requestId, now);
      const claimed = await this.getById(created.id);
      if (!claimed) throw new Error('PUBLISH_JOB_NOT_CLAIMABLE');
      return claimed;
    } catch (error) {
      const active = await this.active(now);
      if (!active) throw error;
      await this.audit(input.actor, 'publish.denied', 'staging', input.requestId, {
        phase: active.status,
      }).run();
      throw new Error('PUBLISH_SLOT_BUSY');
    }
  }

  async availability(
    now = new Date().toISOString(),
  ): Promise<
    { state: 'available' } | { state: 'busy'; phase: 'queued' | 'running'; retryAt: string }
  > {
    const active = await this.active(now);
    return active?.leaseExpiresAt
      ? {
          state: 'busy',
          phase: active.status as 'queued' | 'running',
          retryAt: active.leaseExpiresAt,
        }
      : { state: 'available' };
  }

  async markRunning(
    id: string,
    actor: string,
    requestId: string,
    now = new Date().toISOString(),
  ): Promise<void> {
    const update = await this.database
      .prepare(
        "UPDATE publish_jobs SET status='running',completed_at=NULL,lease_expires_at=? WHERE id=? AND status IN ('queued','failed','cancelled')",
      )
      .bind(leaseExpiry(now), id)
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
          "UPDATE publish_jobs SET status='succeeded',result_sha=?,external_url=?,evidence_json=?,completed_at=?,lease_expires_at=NULL WHERE id=? AND status='running'",
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
          "UPDATE publish_jobs SET status='failed',evidence_json=?,completed_at=?,lease_expires_at=NULL WHERE id=? AND status='running'",
        )
        .bind(JSON.stringify({ failureCode: code }), new Date().toISOString(), id),
      this.audit(actor, 'publish.failed', id, requestId, { failureCode: code }),
    ]);
  }

  private async active(now: string): Promise<PublishJobRecord | null> {
    const row = await this.database
      .prepare(
        `SELECT ${selection} FROM publish_jobs WHERE environment='staging' AND status IN ('queued','running') AND lease_expires_at>? ORDER BY requested_at DESC,id DESC LIMIT 1`,
      )
      .bind(now)
      .first<JobRow>();
    return row ? fromRow(row) : null;
  }

  private async recoverExpiredLease(now: string, actor: string, requestId: string): Promise<void> {
    const expired = await this.database
      .prepare(
        `SELECT ${selection} FROM publish_jobs WHERE environment='staging' AND status IN ('queued','running') AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY requested_at DESC,id DESC LIMIT 1`,
      )
      .bind(now)
      .first<JobRow>();
    if (!expired) return;
    const update = await this.database
      .prepare(
        "UPDATE publish_jobs SET status='cancelled',completed_at=?,lease_expires_at=NULL,evidence_json=? WHERE id=? AND status IN ('queued','running')",
      )
      .bind(now, JSON.stringify({ failureCode: 'PUBLISH_LEASE_EXPIRED' }), expired.id)
      .run();
    if (!update.meta.changes) return;
    await this.audit(actor, 'publish.lease-recovered', expired.id, requestId, {
      previousPhase: expired.status,
    }).run();
  }

  async recordVerification(
    id: string,
    actor: string,
    requestId: string,
    evidence: Record<string, unknown>,
  ): Promise<void> {
    const serialized = JSON.stringify(evidence);
    if (serialized.length > 32_768) throw new Error('PUBLISH_EVIDENCE_TOO_LARGE');
    const current = await this.getById(id);
    if (!current || current.status !== 'succeeded') throw new Error('PUBLISH_JOB_NOT_VERIFIABLE');
    if (JSON.stringify(current.evidence) === serialized) return;
    const update = await this.database
      .prepare("UPDATE publish_jobs SET evidence_json=? WHERE id=? AND status='succeeded'")
      .bind(serialized, id)
      .run();
    if (!update.meta.changes) throw new Error('PUBLISH_JOB_NOT_VERIFIABLE');
    await this.audit(actor, 'publish.verification-recorded', id, requestId, {
      verificationStatus:
        typeof evidence.verificationStatus === 'string'
          ? evidence.verificationStatus.slice(0, 30)
          : 'unknown',
    }).run();
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
