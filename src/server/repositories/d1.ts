import { checksumDocument } from '../../site-kit/canonicalize';
import { migrateDocument } from '../../site-kit/migrations';
import type {
  AuditEventRecord,
  CreateDraftInput,
  DraftRecord,
  DraftRepository,
  DraftStatus,
  RestoreRevisionInput,
  RevisionRecord,
  SaveDraftInput,
} from './contracts';
import { ConflictError, NotFoundError } from './memory';

interface DraftRow {
  id: string;
  site_id: 'pointsite';
  name: string;
  status: DraftStatus;
  latest_revision_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  revision_id: string;
  sequence: number;
  parent_revision_id: string | null;
  checksum: string;
  document_json: string;
  label: string | null;
  schema_version: number;
  renderer_version: string;
  revision_created_by: string;
  revision_created_at: string;
}

interface RevisionRow {
  id: string;
  draft_id: string;
  sequence: number;
  parent_revision_id: string | null;
  checksum: string;
  document_json: string;
  label: string | null;
  schema_version: number;
  renderer_version: string;
  created_by: string;
  created_at: string;
}

const DRAFT_SELECT = `
  SELECT d.id, d.site_id, d.name, d.status, d.latest_revision_id,
    d.created_by, d.created_at, d.updated_at, d.deleted_at,
    r.id AS revision_id, r.sequence, r.parent_revision_id, r.checksum,
    r.document_json,
    COALESCE((SELECT rl.label FROM revision_labels rl WHERE rl.revision_id = r.id ORDER BY rl.created_at DESC, rl.id DESC LIMIT 1), r.label) AS label,
    r.schema_version, r.renderer_version,
    r.created_by AS revision_created_by, r.created_at AS revision_created_at
  FROM drafts d
  JOIN revisions r ON r.id = d.latest_revision_id
`;

function parseRevision(row: RevisionRow): RevisionRecord {
  const document = migrateDocument(JSON.parse(row.document_json)).document;
  return {
    id: row.id,
    draftId: row.draft_id,
    sequence: row.sequence,
    parentRevisionId: row.parent_revision_id,
    checksum: row.checksum,
    document,
    label: row.label,
    schemaVersion: document.schemaVersion,
    rendererVersion: document.rendererVersion,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function parseDraft(row: DraftRow): DraftRecord {
  const revision = parseRevision({
    id: row.revision_id,
    draft_id: row.id,
    sequence: row.sequence,
    parent_revision_id: row.parent_revision_id,
    checksum: row.checksum,
    document_json: row.document_json,
    label: row.label,
    schema_version: row.schema_version,
    renderer_version: row.renderer_version,
    created_by: row.revision_created_by,
    created_at: row.revision_created_at,
  });
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    status: row.status,
    latestRevisionId: row.latest_revision_id,
    document: revision.document,
    revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export class D1DraftRepository implements DraftRepository {
  constructor(private readonly database: D1Database) {}

  async listDrafts(status?: DraftStatus): Promise<DraftRecord[]> {
    const query = status
      ? `${DRAFT_SELECT} WHERE d.status = ? ORDER BY d.updated_at DESC LIMIT 100`
      : `${DRAFT_SELECT} ORDER BY d.updated_at DESC LIMIT 100`;
    const statement = status
      ? this.database.prepare(query).bind(status)
      : this.database.prepare(query);
    const result = await statement.all<DraftRow>();
    return result.results.map(parseDraft);
  }

  async getDraft(id: string): Promise<DraftRecord> {
    const row = await this.database
      .prepare(`${DRAFT_SELECT} WHERE d.id = ?`)
      .bind(id)
      .first<DraftRow>();
    if (!row) throw new NotFoundError(`Draft ${id} was not found`);
    return parseDraft(row);
  }

  async getRevision(id: string): Promise<RevisionRecord> {
    const row = await this.database
      .prepare(
        `SELECT r.id, r.draft_id, r.sequence, r.parent_revision_id, r.checksum, r.document_json,
        COALESCE((SELECT rl.label FROM revision_labels rl WHERE rl.revision_id = r.id ORDER BY rl.created_at DESC, rl.id DESC LIMIT 1), r.label) AS label,
        r.schema_version, r.renderer_version, r.created_by, r.created_at FROM revisions r WHERE r.id = ?`,
      )
      .bind(id)
      .first<RevisionRow>();
    if (!row) throw new NotFoundError(`Revision ${id} was not found`);
    return parseRevision(row);
  }

  async createDraft(input: CreateDraftInput): Promise<DraftRecord> {
    const prior = await this.readIdempotent('draft.create', input.actor, input.idempotencyKey);
    if (prior) return prior;

    const document = migrateDocument(input.document).document;
    const checksum = await checksumDocument(document);
    const now = new Date().toISOString();
    const draftId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const record: DraftRecord = {
      id: draftId,
      siteId: 'pointsite',
      name: input.name,
      status: 'active',
      latestRevisionId: revisionId,
      document,
      revision: {
        id: revisionId,
        draftId,
        sequence: 1,
        parentRevisionId: null,
        checksum,
        document,
        label: 'Initial PointSite import',
        schemaVersion: document.schemaVersion,
        rendererVersion: document.rendererVersion,
        createdBy: input.actor,
        createdAt: now,
      },
      createdBy: input.actor,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const responseJson = JSON.stringify(record);
    const requestHash = await checksumDocument({ name: input.name, document });
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO drafts (id,site_id,name,status,created_by,created_at,updated_at) VALUES (?, 'pointsite', ?, 'active', ?, ?, ?)`,
        )
        .bind(draftId, input.name, input.actor, now, now),
      this.database
        .prepare(
          `INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at) VALUES (?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          revisionId,
          draftId,
          checksum,
          JSON.stringify(document),
          record.revision.label,
          document.schemaVersion,
          document.rendererVersion,
          input.actor,
          now,
        ),
      this.database
        .prepare(`UPDATE drafts SET latest_revision_id = ? WHERE id = ?`)
        .bind(revisionId, draftId),
      this.auditStatement(input.actor, 'draft.create', draftId, input.requestId, {
        revisionId,
        sequence: 1,
      }),
      this.idempotencyStatement(
        'draft.create',
        input.idempotencyKey,
        input.actor,
        requestHash,
        201,
        responseJson,
        now,
      ),
    ]);
    return record;
  }

  async saveDraft(input: SaveDraftInput): Promise<DraftRecord> {
    const prior = await this.readIdempotent('draft.save', input.actor, input.idempotencyKey);
    if (prior) return prior;
    const current = await this.getDraft(input.draftId);
    if (current.status !== 'active') throw new ConflictError('Only active drafts can be saved');
    if (current.revision.checksum !== input.expectedChecksum)
      throw new ConflictError('The draft has a newer revision');

    const document = migrateDocument(input.document).document;
    const checksum = await checksumDocument(document);
    if (checksum === current.revision.checksum) return current;
    const now = new Date().toISOString();
    const revisionId = crypto.randomUUID();
    const revision: RevisionRecord = {
      id: revisionId,
      draftId: current.id,
      sequence: current.revision.sequence + 1,
      parentRevisionId: current.revision.id,
      checksum,
      document,
      label: input.label ?? null,
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      createdBy: input.actor,
      createdAt: now,
    };
    const record: DraftRecord = {
      ...current,
      latestRevisionId: revisionId,
      document,
      revision,
      updatedAt: now,
    };
    const requestHash = await checksumDocument({
      draftId: current.id,
      expectedChecksum: input.expectedChecksum,
      document,
    });
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at) SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM drafts WHERE id = ? AND latest_revision_id = ?`,
        )
        .bind(
          revisionId,
          revision.sequence,
          revision.parentRevisionId,
          checksum,
          JSON.stringify(document),
          revision.label,
          document.schemaVersion,
          document.rendererVersion,
          input.actor,
          now,
          current.id,
          current.revision.id,
        ),
      this.database
        .prepare(
          `UPDATE drafts SET latest_revision_id = ?, updated_at = ? WHERE id = ? AND latest_revision_id = ?`,
        )
        .bind(revisionId, now, current.id, current.revision.id),
      this.auditStatement(input.actor, 'draft.save', current.id, input.requestId, {
        revisionId,
        sequence: revision.sequence,
      }),
      this.idempotencyStatement(
        'draft.save',
        input.idempotencyKey,
        input.actor,
        requestHash,
        200,
        JSON.stringify(record),
        now,
      ),
    ]);
    return record;
  }

  async listRevisions(draftId: string): Promise<RevisionRecord[]> {
    const result = await this.database
      .prepare(
        `SELECT r.id, r.draft_id, r.sequence, r.parent_revision_id, r.checksum, r.document_json,
        COALESCE((SELECT rl.label FROM revision_labels rl WHERE rl.revision_id = r.id ORDER BY rl.created_at DESC, rl.id DESC LIMIT 1), r.label) AS label,
        r.schema_version, r.renderer_version, r.created_by, r.created_at
        FROM revisions r WHERE r.draft_id = ? ORDER BY r.sequence DESC LIMIT 100`,
      )
      .bind(draftId)
      .all<RevisionRow>();
    return result.results.map(parseRevision);
  }

  async restoreRevision(input: RestoreRevisionInput): Promise<DraftRecord> {
    const source = await this.database
      .prepare(`SELECT * FROM revisions WHERE id = ? AND draft_id = ?`)
      .bind(input.revisionId, input.draftId)
      .first<RevisionRow>();
    if (!source) throw new NotFoundError(`Revision ${input.revisionId} was not found`);
    return this.saveDraft({
      ...input,
      document: parseRevision(source).document,
      idempotencyKey: `restore:${input.idempotencyKey.slice(0, 92)}`,
      label: `Restored revision ${source.sequence}`,
    });
  }

  async labelRevision(
    draftId: string,
    revisionId: string,
    label: string,
    actor: string,
    requestId: string,
  ): Promise<RevisionRecord> {
    const source = await this.database
      .prepare('SELECT * FROM revisions WHERE id = ? AND draft_id = ?')
      .bind(revisionId, draftId)
      .first<RevisionRow>();
    if (!source) throw new NotFoundError(`Revision ${revisionId} was not found`);
    await this.database.batch([
      this.database
        .prepare(
          'INSERT INTO revision_labels (id,revision_id,label,created_by,created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(crypto.randomUUID(), revisionId, label, actor, new Date().toISOString()),
      this.auditStatement(actor, 'revision.label', revisionId, requestId, { draftId }),
    ]);
    return { ...parseRevision(source), label };
  }

  async renameDraft(
    draftId: string,
    name: string,
    actor: string,
    requestId: string,
  ): Promise<DraftRecord> {
    const current = await this.getDraft(draftId);
    if (current.status === 'deleted') throw new ConflictError('Deleted drafts cannot be renamed');
    const now = new Date().toISOString();
    await this.database.batch([
      this.database
        .prepare('UPDATE drafts SET name = ?, updated_at = ? WHERE id = ? AND status != ?')
        .bind(name, now, draftId, 'deleted'),
      this.auditStatement(actor, 'draft.rename', draftId, requestId, {}),
    ]);
    return { ...current, name, updatedAt: now };
  }

  async setDraftStatus(
    draftId: string,
    status: DraftStatus,
    actor: string,
    requestId: string,
  ): Promise<DraftRecord> {
    const current = await this.getDraft(draftId);
    if (current.status === status) return current;
    const allowed =
      (current.status === 'active' && (status === 'archived' || status === 'deleted')) ||
      (current.status === 'archived' && (status === 'active' || status === 'deleted'));
    if (!allowed) throw new ConflictError(`Cannot change ${current.status} draft to ${status}`);
    const now = new Date().toISOString();
    const deletedAt = status === 'deleted' ? now : null;
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE drafts SET status = ?, updated_at = ?, deleted_at = ? WHERE id = ? AND status = ?`,
        )
        .bind(status, now, deletedAt, draftId, current.status),
      this.auditStatement(actor, `draft.${status}`, draftId, requestId, {
        previousStatus: current.status,
      }),
    ]);
    return { ...current, status, updatedAt: now, deletedAt };
  }

  private async readIdempotent(
    scope: string,
    actor: string,
    key: string,
  ): Promise<DraftRecord | null> {
    const row = await this.database
      .prepare(
        `SELECT response_json FROM idempotency_keys WHERE scope = ? AND actor = ? AND idempotency_key = ? AND expires_at > ?`,
      )
      .bind(scope, actor, key, new Date().toISOString())
      .first<{ response_json: string }>();
    return row ? (JSON.parse(row.response_json) as DraftRecord) : null;
  }

  private idempotencyStatement(
    scope: string,
    key: string,
    actor: string,
    requestHash: string,
    statusCode: number,
    responseJson: string,
    now: string,
  ): D1PreparedStatement {
    const expires = new Date(Date.parse(now) + 24 * 60 * 60 * 1_000).toISOString();
    return this.database
      .prepare(
        `INSERT INTO idempotency_keys (scope,idempotency_key,actor,request_hash,status_code,response_json,created_at,expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(scope, key, actor, requestHash, statusCode, responseJson, now, expires);
  }

  private auditStatement(
    actor: string,
    action: string,
    targetId: string,
    requestId: string,
    metadata: AuditEventRecord['metadata'],
  ): D1PreparedStatement {
    return this.database
      .prepare(
        `INSERT INTO audit_events (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json) VALUES (?, ?, ?, ?, 'draft', ?, 'succeeded', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        new Date().toISOString(),
        actor,
        action,
        targetId,
        requestId,
        JSON.stringify(metadata),
      );
  }
}
