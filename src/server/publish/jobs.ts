import { z } from 'zod';
import type { DraftRecord } from '../repositories/contracts';
import { MAX_DISPATCH_ATTEMPTS } from './dispatch';
import { preparePublicationInputs } from './inputs';
import { recoverQueuedPublication, type QueuedRecoveryInput } from './recovery';
import { retryCapturedStaging } from './retry';
import { reconcileCompletedPublication } from './reconcile';

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

const activeCandidate = `COALESCE(json_extract(candidate_json,'$.publicationProtocol'),1)=1 AND EXISTS (
  SELECT 1 FROM drafts d JOIN revisions r ON r.id=d.latest_revision_id AND r.draft_id=d.id
  WHERE d.status='active' AND d.id=json_extract(candidate_json,'$.draftId')
    AND r.id=json_extract(candidate_json,'$.revisionId')
    AND r.checksum=json_extract(candidate_json,'$.revisionChecksum')
)`;

export class D1PublishJobStore {
  constructor(private readonly database: D1Database) {}

  recoverQueued(input: QueuedRecoveryInput) {
    if (input.action === 'verify-completed')
      return reconcileCompletedPublication(this.database, input);
    return recoverQueuedPublication(this.database, input);
  }

  retryCaptured(
    input: QueuedRecoveryInput,
    workflowRevision: string,
    verifyBase: (sha: string) => Promise<void>,
  ) {
    return retryCapturedStaging(this.database, input, workflowRevision, verifyBase);
  }

  /** Capture once. Browser closure and later edits cannot substitute these inputs. */
  async captureStaging(input: {
    draft: DraftRecord;
    workflowRevision: string;
    baseSha: string;
    actor: string;
    idempotencyKey: string;
    requestId: string;
    preflightId?: string;
  }): Promise<PublishJobRecord> {
    z.string()
      .regex(/^[A-Za-z0-9._:-]{16,100}$/)
      .parse(input.idempotencyKey);
    z.string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(input.baseSha);
    const id = crypto.randomUUID();
    const prepared = await preparePublicationInputs(
      this.database,
      input.draft,
      id,
      input.workflowRevision,
    );
    const authority = this.database
      .prepare(
        `SELECT json(CASE WHEN EXISTS (
      SELECT 1 FROM user_roles WHERE email=? AND active=1 AND role IN ('publisher','administrator')
    ) THEN 'true' ELSE 'publication authority changed' END)`,
      )
      .bind(input.actor);
    const existing = await this.getByKey(input.idempotencyKey);
    if (existing) {
      await authority.first();
      if (
        existing.candidateChecksum !== prepared.candidateChecksum ||
        existing.baseSha !== input.baseSha ||
        existing.requestedBy !== input.actor
      )
        throw new Error('IDEMPOTENCY_CONFLICT');
      return existing;
    }
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const now = new Date().toISOString();
    try {
      await this.database.batch([
        authority,
        ...(input.preflightId
          ? [
              this.database
                .prepare(
                  `SELECT json(CASE WHEN EXISTS (
          SELECT 1 FROM publish_preflights WHERE id=? AND draft_id=? AND revision_id=?
            AND revision_checksum=? AND candidate_checksum=? AND status='passed'
            AND id=(SELECT id FROM publish_preflights WHERE draft_id=? ORDER BY completed_at DESC,rowid DESC LIMIT 1)
        ) THEN 'true' ELSE 'publication preflight changed' END)`,
                )
                .bind(
                  input.preflightId,
                  input.draft.id,
                  input.draft.revision.id,
                  input.draft.revision.checksum,
                  prepared.candidateChecksum,
                  input.draft.id,
                ),
            ]
          : []),
        this.database
          .prepare(
            `SELECT json(CASE WHEN EXISTS (
        SELECT 1 FROM drafts d JOIN revisions r ON r.id=d.latest_revision_id AND r.draft_id=d.id
        WHERE d.id=? AND d.status='active' AND r.id=? AND r.checksum=?
      ) THEN 'true' ELSE 'publication revision changed' END)`,
          )
          .bind(input.draft.id, input.draft.revision.id, input.draft.revision.checksum),
        this.database.prepare(`SELECT json(CASE WHEN NOT EXISTS (
        SELECT 1 FROM publication_slots WHERE target='staging'
      ) AND NOT EXISTS (
        SELECT 1 FROM publish_jobs WHERE environment='staging' AND status IN ('queued','running')
      ) THEN 'true' ELSE 'publication slot occupied' END)`),
        this.database
          .prepare(
            `INSERT INTO publish_jobs
        (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at)
        VALUES (?,?,'staging','queued',?,?,'PointCommunity/pointsite-staging',?,?,?)`,
          )
          .bind(
            id,
            input.idempotencyKey,
            JSON.stringify(prepared.candidate),
            prepared.candidateChecksum,
            input.baseSha,
            input.actor,
            now,
          ),
        ...prepared.statements,
        this.database
          .prepare("INSERT INTO publication_slots(target,job_id) VALUES ('staging',?)")
          .bind(id),
        this.database
          .prepare('INSERT INTO publication_runs(job_id,nonce,dispatch_revision) VALUES (?,?,?)')
          .bind(id, nonce, input.baseSha),
        this.audit(input.actor, 'publish.queued', id, input.requestId, {
          candidateChecksum: prepared.candidateChecksum,
          baseSha: input.baseSha,
        }),
      ]);
    } catch (error) {
      // Another identical request may have committed while this one prepared inputs.
      const committed = await this.getByKey(input.idempotencyKey);
      if (!committed) throw error;
      await authority.first();
      if (
        committed.candidateChecksum !== prepared.candidateChecksum ||
        committed.baseSha !== input.baseSha ||
        committed.requestedBy !== input.actor
      )
        throw new Error('IDEMPOTENCY_CONFLICT');
      return committed;
    }
    const created = await this.getById(id);
    if (!created) throw new Error('PUBLISH_JOB_CREATE_FAILED');
    return created;
  }

  async capturedRetry(
    key: string,
    actor: string,
    baseSha: string,
    candidate: {
      draftId: string;
      revisionId: string;
      revisionChecksum: string;
      workflowRevision: string;
    },
  ) {
    const job = await this.getByKey(key);
    if (!job) return null;
    if (
      job.requestedBy !== actor ||
      job.baseSha !== baseSha ||
      job.candidate.publicationProtocol !== 2 ||
      Object.entries(candidate).some(([name, value]) => job.candidate[name] !== value)
    )
      throw new Error('IDEMPOTENCY_CONFLICT');
    const authorized = await this.database
      .prepare(
        `SELECT 1 FROM user_roles WHERE email=? AND active=1
      AND role IN ('publisher','administrator')`,
      )
      .bind(actor)
      .first();
    if (!authorized) throw new Error('PUBLISH_AUTHORITY_CHANGED');
    return job;
  }

  prepareInputs(draft: DraftRecord, workflowRevision: string) {
    return preparePublicationInputs(this.database, draft, crypto.randomUUID(), workflowRevision);
  }

  async draftHead(draftId: string) {
    const row = await this.database
      .prepare(
        `SELECT r.id,r.checksum FROM drafts d
      JOIN revisions r ON r.id=d.latest_revision_id AND r.draft_id=d.id WHERE d.id=?`,
      )
      .bind(draftId)
      .first<{ id: string; checksum: string }>();
    if (!row) throw new Error('DRAFT_NOT_FOUND');
    return { revision: row };
  }

  async cloudAvailability() {
    const row = await this.database
      .prepare(
        `SELECT j.status FROM publication_slots s
      JOIN publish_jobs j ON j.id=s.job_id WHERE s.target='staging'`,
      )
      .first<{ status: PublishJobStatus }>();
    if (row)
      return {
        state: 'busy' as const,
        phase:
          row.status === 'succeeded'
            ? ('review' as const)
            : row.status === 'queued' || row.status === 'running'
              ? row.status
              : ('recovery' as const),
      };
    // A legacy process may still have an external effect after its lease expires.
    const legacy = await this.database
      .prepare(
        `SELECT status FROM publish_jobs
      WHERE environment='staging' AND status IN ('queued','running') LIMIT 1`,
      )
      .first<{ status: 'queued' | 'running' }>();
    return legacy
      ? { state: 'busy' as const, phase: legacy.status }
      : { state: 'available' as const };
  }

  async dispatchStatus(id: string) {
    const row = await this.database
      .prepare(
        `SELECT dispatch_count,dispatch_after,dispatch_error,j.environment,
      COALESCE(run_id,reserved_run_id) AS run_id,
      (reserved_run_id IS NOT NULL AND deploy_authorized_at IS NULL
        AND j.status IN ('queued','running')) AS can_reconcile,
      (j.environment='staging' AND j.status='cancelled' AND pr.deploy_authorized_at IS NULL
        AND COALESCE((SELECT attempt FROM publication_retries WHERE job_id=j.id),0)<3
        AND NOT EXISTS(SELECT 1 FROM publication_retries WHERE parent_job_id=j.id)) AS can_retry_captured,
      (j.status='running' AND pr.deploy_authorized_at IS NOT NULL AND pr.deployment_json IS NOT NULL
        AND pr.run_id IS NOT NULL) AS can_verify_completed
      FROM publication_runs pr JOIN publish_jobs j ON j.id=pr.job_id WHERE job_id=?`,
      )
      .bind(id)
      .first<{
        dispatch_count: number;
        dispatch_after: string;
        dispatch_error: string | null;
        run_id: string | null;
        environment: string;
        can_reconcile: number;
        can_retry_captured: number;
        can_verify_completed: number;
      }>();
    if (!row) return undefined;
    return {
      attempts: row.dispatch_count,
      retryAt: row.dispatch_after,
      reserved: row.run_id !== null,
      canReconcileStopped: row.can_reconcile === 1,
      canRetryCaptured: row.can_retry_captured === 1,
      canVerifyCompleted: row.can_verify_completed === 1,
      needsAttention: !row.run_id && row.dispatch_count >= MAX_DISPATCH_ATTEMPTS,
      ...(row.dispatch_error ? { failureCode: row.dispatch_error } : {}),
      ...(row.run_id && /^[1-9][0-9]*$/.test(row.run_id)
        ? {
            workflowUrl: `https://github.com/PointCommunity/${row.environment === 'staging' ? 'pointsite-staging' : 'pointsite'}/actions/runs/${row.run_id}`,
          }
        : {}),
    };
  }

  async getByKey(key: string): Promise<PublishJobRecord | null> {
    const row = await this.database
      .prepare(
        `SELECT ${selection} FROM publish_jobs WHERE idempotency_key=? AND environment='staging'`,
      )
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
    const result = await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO publish_jobs (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at,lease_expires_at)
           SELECT ?,?,'staging','queued',candidate_json,?,'PointCommunity/pointsite-staging',?,?,?,?
           FROM (SELECT ? AS candidate_json) WHERE ${activeCandidate}`,
        )
        .bind(
          id,
          input.idempotencyKey,
          input.candidateChecksum,
          input.baseSha,
          input.actor,
          now,
          leaseExpiry(now),
          JSON.stringify(input.candidate),
        ),
      this.audit(
        input.actor,
        'publish.queued',
        id,
        input.requestId,
        {
          candidateChecksum: input.candidateChecksum,
          baseSha: input.baseSha,
        },
        'succeeded',
        true,
      ),
    ]);
    if (!result[0]?.meta.changes) throw new Error('DRAFT_REVISION_DRIFT');
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
    if (
      existing &&
      (existing.candidateChecksum !== input.candidateChecksum || existing.baseSha !== input.baseSha)
    )
      throw new Error('IDEMPOTENCY_CONFLICT');
    if (existing?.status === 'succeeded') return existing;
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
            `UPDATE publish_jobs SET status='running',completed_at=NULL,lease_expires_at=? WHERE id=? AND status IN ('failed','cancelled') AND ${activeCandidate}`,
          )
          .bind(leaseExpiry(now), existing.id)
          .run();
        if (!update.meta.changes) throw new Error('PUBLISH_JOB_NOT_CLAIMABLE');
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
      await this.audit(
        input.actor,
        'publish.denied',
        'staging',
        input.requestId,
        {
          phase: active.status,
        },
        'denied',
      ).run();
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
        `UPDATE publish_jobs SET status='running',completed_at=NULL,lease_expires_at=? WHERE id=? AND status IN ('queued','failed','cancelled') AND ${activeCandidate}`,
      )
      .bind(leaseExpiry(now), id)
      .run();
    if (!update.meta.changes) throw new Error('PUBLISH_JOB_NOT_CLAIMABLE');
    await this.audit(actor, 'publish.running', id, requestId, {}).run();
  }

  async acquireStep(id: string): Promise<{ token: string; job: PublishJobRecord }> {
    const token = crypto.randomUUID();
    const now = new Date().toISOString();
    const update = await this.database
      .prepare(
        `UPDATE publish_jobs
      SET evidence_json=json_set(evidence_json,'$.stepToken',?,'$.stepExpiresAt',?),lease_expires_at=?
      WHERE id=? AND status='running' AND lease_expires_at>?
        AND (json_extract(evidence_json,'$.stepExpiresAt') IS NULL OR json_extract(evidence_json,'$.stepExpiresAt')<=?)
        AND ${activeCandidate}`,
      )
      .bind(
        token,
        new Date(Date.parse(now) + 120_000).toISOString(),
        leaseExpiry(now),
        id,
        now,
        now,
      )
      .run();
    if (!update.meta.changes) throw new Error('PUBLISH_STEP_UNAVAILABLE');
    const job = await this.getById(id);
    if (!job) throw new Error('PUBLISH_STEP_UNAVAILABLE');
    return { token, job };
  }

  async guardStep(id: string, token: string): Promise<void> {
    const now = new Date().toISOString();
    const row = await this.database
      .prepare(
        `SELECT id FROM publish_jobs WHERE id=? AND status='running'
      AND lease_expires_at>? AND json_extract(evidence_json,'$.stepToken')=?
      AND json_extract(evidence_json,'$.stepExpiresAt')>? AND ${activeCandidate}`,
      )
      .bind(id, now, token, now)
      .first();
    if (!row) throw new Error('DRAFT_REVISION_DRIFT');
  }

  async checkpoint(
    id: string,
    token: string,
    progress: { blobShas: string[]; commit?: { sha: string; url: string } },
  ): Promise<void> {
    const now = new Date().toISOString();
    const update = await this.database
      .prepare(
        `UPDATE publish_jobs SET evidence_json=json_set(evidence_json,'$.upload',json(?))
      WHERE id=? AND status='running' AND lease_expires_at>? AND json_extract(evidence_json,'$.stepToken')=?
      AND json_extract(evidence_json,'$.stepExpiresAt')>? AND ${activeCandidate}`,
      )
      .bind(JSON.stringify(progress), id, now, token, now)
      .run();
    if (!update.meta.changes) throw new Error('DRAFT_REVISION_DRIFT');
  }

  async failStep(
    id: string,
    token: string,
    actor: string,
    requestId: string,
    code: string,
  ): Promise<void> {
    const update = await this.database
      .prepare(
        "UPDATE publish_jobs SET status='failed',evidence_json=json_patch(evidence_json,?),completed_at=?,lease_expires_at=NULL WHERE id=? AND status='running' AND json_extract(evidence_json,'$.stepToken')=?",
      )
      .bind(JSON.stringify({ failureCode: code }), new Date().toISOString(), id, token)
      .run();
    if (update.meta.changes)
      await this.audit(
        actor,
        'publish.failed',
        id,
        requestId,
        { failureCode: code },
        'failed',
      ).run();
  }

  async releaseStep(id: string, token: string): Promise<void> {
    await this.database
      .prepare(
        "UPDATE publish_jobs SET evidence_json=json_remove(evidence_json,'$.stepToken','$.stepExpiresAt') WHERE id=? AND json_extract(evidence_json,'$.stepToken')=?",
      )
      .bind(id, token)
      .run();
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
          "UPDATE publish_jobs SET status='failed',evidence_json=json_patch(evidence_json,?),completed_at=?,lease_expires_at=NULL WHERE id=? AND status='running'",
        )
        .bind(JSON.stringify({ failureCode: code }), new Date().toISOString(), id),
      this.audit(actor, 'publish.failed', id, requestId, { failureCode: code }, 'failed'),
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
        `SELECT ${selection} FROM publish_jobs WHERE environment='staging' AND status IN ('queued','running') AND COALESCE(json_extract(candidate_json,'$.publicationProtocol'),1)=1 AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY requested_at DESC,id DESC LIMIT 1`,
      )
      .bind(now)
      .first<JobRow>();
    if (!expired) return;
    const update = await this.database
      .prepare(
        "UPDATE publish_jobs SET status='cancelled',completed_at=?,lease_expires_at=NULL,evidence_json=json_patch(evidence_json,?) WHERE id=? AND status IN ('queued','running')",
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
    outcome: 'succeeded' | 'failed' | 'denied' = 'succeeded',
    onlyIfJobExists = false,
  ) {
    return this.database
      .prepare(
        `INSERT INTO audit_events (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json) SELECT ?,?,?,?,?,?,?,?,?${onlyIfJobExists ? ' WHERE EXISTS (SELECT 1 FROM publish_jobs WHERE id=?)' : ''}`,
      )
      .bind(
        crypto.randomUUID(),
        new Date().toISOString(),
        actor,
        action,
        'publish-job',
        id,
        outcome,
        requestId,
        JSON.stringify(metadata),
        ...(onlyIfJobExists ? [id] : []),
      );
  }
}
