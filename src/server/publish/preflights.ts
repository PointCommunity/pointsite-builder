export type PublishPreflightStatus = 'passed' | 'failed';

export interface PublishPreflightRecord {
  id: string;
  idempotencyKey: string;
  draftId: string;
  revisionId: string;
  revisionChecksum: string;
  candidateChecksum: string | null;
  schemaVersion: number | null;
  rendererVersion: string | null;
  rendererContractChecksum: string;
  validatedBaseSha: string | null;
  fileCount: number | null;
  status: PublishPreflightStatus;
  failureCode: string | null;
  requestedBy: string;
  requestedAt: string;
  completedAt: string;
}

interface PreflightRow {
  id: string;
  idempotency_key: string;
  draft_id: string;
  revision_id: string;
  revision_checksum: string;
  candidate_checksum: string | null;
  schema_version: number | null;
  renderer_version: string | null;
  renderer_contract_checksum: string;
  validated_base_sha: string | null;
  file_count: number | null;
  status: PublishPreflightStatus;
  failure_code: string | null;
  requested_by: string;
  requested_at: string;
  completed_at: string;
}

const selection =
  'id,idempotency_key,draft_id,revision_id,revision_checksum,candidate_checksum,schema_version,renderer_version,renderer_contract_checksum,validated_base_sha,file_count,status,failure_code,requested_by,requested_at,completed_at';

const fromRow = (row: PreflightRow): PublishPreflightRecord => ({
  id: row.id,
  idempotencyKey: row.idempotency_key,
  draftId: row.draft_id,
  revisionId: row.revision_id,
  revisionChecksum: row.revision_checksum,
  candidateChecksum: row.candidate_checksum,
  schemaVersion: row.schema_version,
  rendererVersion: row.renderer_version,
  rendererContractChecksum: row.renderer_contract_checksum,
  validatedBaseSha: row.validated_base_sha,
  fileCount: row.file_count,
  status: row.status,
  failureCode: row.failure_code,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  completedAt: row.completed_at,
});

interface BaseInput {
  idempotencyKey: string;
  draftId: string;
  revisionId: string;
  revisionChecksum: string;
  rendererContractChecksum: string;
  actor: string;
  requestId: string;
  now?: string;
}

export class D1PublishPreflightStore {
  constructor(private readonly database: D1Database) {}

  async getByKey(idempotencyKey: string): Promise<PublishPreflightRecord | null> {
    const row = await this.database
      .prepare(`SELECT ${selection} FROM publish_preflights WHERE idempotency_key=?`)
      .bind(idempotencyKey)
      .first<PreflightRow>();
    return row ? fromRow(row) : null;
  }

  async getLatestForDraft(draftId: string): Promise<PublishPreflightRecord | null> {
    const row = await this.database
      .prepare(
        `SELECT ${selection} FROM publish_preflights WHERE draft_id=? ORDER BY completed_at DESC,id DESC LIMIT 1`,
      )
      .bind(draftId)
      .first<PreflightRow>();
    return row ? fromRow(row) : null;
  }

  async getLatestCurrent(
    draftId: string,
    revisionId: string,
    revisionChecksum: string,
    rendererContractChecksum: string,
  ): Promise<PublishPreflightRecord | null> {
    const latest = await this.getLatestForDraft(draftId);
    return latest?.status === 'passed' &&
      latest.revisionId === revisionId &&
      latest.revisionChecksum === revisionChecksum &&
      latest.rendererContractChecksum === rendererContractChecksum
      ? latest
      : null;
  }

  async recordPassed(
    input: BaseInput & {
      candidateChecksum: string;
      schemaVersion: number;
      rendererVersion: string;
      validatedBaseSha: string;
      fileCount: number;
    },
  ): Promise<PublishPreflightRecord> {
    const existing = await this.getByKey(input.idempotencyKey);
    if (existing) return existing;
    const id = crypto.randomUUID();
    const now = input.now ?? new Date().toISOString();
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO publish_preflights (${selection}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          id,
          input.idempotencyKey,
          input.draftId,
          input.revisionId,
          input.revisionChecksum,
          input.candidateChecksum,
          input.schemaVersion,
          input.rendererVersion,
          input.rendererContractChecksum,
          input.validatedBaseSha,
          input.fileCount,
          'passed',
          null,
          input.actor,
          now,
          now,
        ),
      this.audit(input, id, now, 'publish.preflight-passed', {
        revisionId: input.revisionId,
        candidateChecksum: input.candidateChecksum,
      }),
    ]);
    const created = await this.getByKey(input.idempotencyKey);
    if (!created) throw new Error('PREFLIGHT_CREATE_FAILED');
    return created;
  }

  async recordFailed(input: BaseInput & { failureCode: string }): Promise<PublishPreflightRecord> {
    const existing = await this.getByKey(input.idempotencyKey);
    if (existing) return existing;
    const id = crypto.randomUUID();
    const now = input.now ?? new Date().toISOString();
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO publish_preflights (${selection}) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,NULL,NULL,'failed',?,?,?,?)`,
        )
        .bind(
          id,
          input.idempotencyKey,
          input.draftId,
          input.revisionId,
          input.revisionChecksum,
          input.rendererContractChecksum,
          input.failureCode.slice(0, 100),
          input.actor,
          now,
          now,
        ),
      this.audit(input, id, now, 'publish.preflight-failed', {
        revisionId: input.revisionId,
        failureCode: input.failureCode.slice(0, 100),
      }),
    ]);
    const created = await this.getByKey(input.idempotencyKey);
    if (!created) throw new Error('PREFLIGHT_CREATE_FAILED');
    return created;
  }

  private audit(
    input: Pick<BaseInput, 'actor' | 'requestId'>,
    id: string,
    now: string,
    action: string,
    metadata: Record<string, string>,
  ) {
    return this.database
      .prepare(
        "INSERT INTO audit_events (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json) VALUES (?,?,?,?,?,?,'succeeded',?,?)",
      )
      .bind(
        crypto.randomUUID(),
        now,
        input.actor,
        action,
        'publish-preflight',
        id,
        input.requestId,
        JSON.stringify(metadata),
      );
  }
}
