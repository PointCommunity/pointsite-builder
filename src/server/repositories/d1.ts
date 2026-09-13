import { canonicalize, checksumDocument } from '../../site-kit/canonicalize';
import { migrateDocument } from '../../site-kit/migrations';
import { checkoutExpiry } from '../../shared/draft-checkout';
import type { D1DraftAssets } from '../media/draft-assets';
import { D1LibraryProjection } from '../media/library-projection';
import type {
  AuditEventRecord,
  AcquireCheckoutCommand,
  CheckoutCommand,
  CreateDraftInput,
  DeletedDraftReceipt,
  DraftRecord,
  DraftCheckout,
  DraftCheckoutAvailability,
  EditorViewState,
  DraftRepository,
  DraftStatus,
  RestoreRevisionInput,
  RevisionRecord,
  SaveDraftInput,
} from './contracts';
import { ConflictError, NotFoundError } from './memory';
import { createRequestHash, saveRequestHash } from './request-hash';
import { AuthorizationError } from '../auth/roles';

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
  action_category: RevisionRow['action_category'];
  action_context: RevisionRow['action_context'];
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
  action_category: RevisionRecord['actionCategory'];
  action_context: RevisionRecord['actionContext'];
}

const DRAFT_SELECT = `
  SELECT d.id, d.site_id, d.name, d.status, d.latest_revision_id,
    d.created_by, d.created_at, d.updated_at, d.deleted_at,
    r.id AS revision_id, r.sequence, r.parent_revision_id, r.checksum,
    r.document_json,
    COALESCE((SELECT rl.label FROM revision_labels rl WHERE rl.revision_id = r.id ORDER BY rl.created_at DESC, rl.id DESC LIMIT 1), r.label) AS label,
    r.schema_version, r.renderer_version,
    r.created_by AS revision_created_by, r.created_at AS revision_created_at,
    r.action_category, r.action_context
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
    actionCategory: row.action_category,
    actionContext: row.action_context,
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
    action_category: row.action_category,
    action_context: row.action_context,
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
  constructor(
    private readonly database: D1Database,
    private readonly assets?: D1DraftAssets,
  ) {}

  private async assertEditor(actor: string): Promise<void> {
    const allowed = await this.database
      .prepare(
        "SELECT 1 FROM user_roles WHERE email=? AND active=1 AND role IN ('editor','publisher','administrator')",
      )
      .bind(actor)
      .first();
    if (!allowed) throw new AuthorizationError();
  }

  private async commit(actor: string, statements: D1PreparedStatement[]): Promise<D1Result[]> {
    try {
      const results = await this.database.batch([
        this.database
          .prepare(
            `SELECT json(CASE WHEN EXISTS (
          SELECT 1 FROM user_roles WHERE email=? AND active=1 AND role IN ('editor','publisher','administrator')
        ) THEN 'true' ELSE 'actor-forbidden' END)`,
          )
          .bind(actor),
        ...statements,
      ]);
      return results.slice(1);
    } catch (error) {
      await this.assertEditor(actor);
      throw error;
    }
  }

  async listDrafts(status?: DraftStatus): Promise<DraftRecord[]> {
    const query = status
      ? `${DRAFT_SELECT} WHERE d.status = ? ORDER BY d.updated_at DESC LIMIT 100`
      : `${DRAFT_SELECT} WHERE d.status != 'deleted' ORDER BY d.updated_at DESC LIMIT 100`;
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
        r.schema_version, r.renderer_version, r.created_by, r.created_at,
        r.action_category, r.action_context FROM revisions r WHERE r.id = ?`,
      )
      .bind(id)
      .first<RevisionRow>();
    if (!row) throw new NotFoundError(`Revision ${id} was not found`);
    return parseRevision(row);
  }

  async createDraft(input: CreateDraftInput): Promise<DraftRecord> {
    const requestHash = await createRequestHash(input);
    const prior = await this.readIdempotent('draft.create', input, requestHash);
    if (prior) return prior;

    const now = new Date().toISOString();
    const draftId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const prepared = this.assets
      ? await this.assets.prepareCreate({
          draftId,
          document: migrateDocument(input.document).document,
          sourceDraftId: input.sourceDraftId,
          actor: input.actor,
          now,
        })
      : { document: migrateDocument(input.document).document, statements: [] };
    const document = prepared.document;
    const checksum = await checksumDocument(document);
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
        actionCategory: 'add',
        actionContext: 'draft',
      },
      createdBy: input.actor,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const responseJson = JSON.stringify(record);
    try {
      await this.commit(input.actor, [
        ...(input.sourceDraftId
          ? [
              this.database
                .prepare(
                  `SELECT json(CASE WHEN EXISTS (
          SELECT 1 FROM drafts WHERE id=? AND status!='deleted'
        ) THEN 'true' ELSE 'source-draft-deleted' END)`,
                )
                .bind(input.sourceDraftId),
            ]
          : []),
        this.database
          .prepare(
            `INSERT INTO drafts (id,site_id,name,status,created_by,created_at,updated_at) VALUES (?, 'pointsite', ?, 'active', ?, ?, ?)`,
          )
          .bind(draftId, input.name, input.actor, now, now),
        ...prepared.statements,
        this.database
          .prepare(
            `INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at,action_category,action_context) VALUES (?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            record.revision.actionCategory,
            record.revision.actionContext,
          ),
        this.database
          .prepare(`UPDATE drafts SET latest_revision_id = ? WHERE id = ?`)
          .bind(revisionId, draftId),
        ...new D1LibraryProjection(this.database).statements(record.revision, 0),
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
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed: idempotency_keys')
      ) {
        const replay = await this.readIdempotent('draft.create', input, requestHash);
        if (replay) return replay;
      }
      throw error;
    }
  }

  async saveDraft(
    input: SaveDraftInput,
    additionalStatements: D1PreparedStatement[] = [],
    preparedSourcePaths?: Set<string>,
  ): Promise<DraftRecord> {
    if (input.checkoutToken)
      await this.assertCheckout(input.draftId, input.actor, input.checkoutToken);
    const current = await this.getDraft(input.draftId);
    if (current.status !== 'active') throw new ConflictError('Only active drafts can be saved');
    const requestHash = await saveRequestHash(input);
    const prior = await this.readIdempotent('draft.save', input, requestHash);
    if (prior) return prior;
    if (input.expectedRevisionId && input.expectedRevisionId !== current.revision.id)
      throw new ConflictError('The draft has a newer revision');
    if (current.revision.checksum !== input.expectedChecksum)
      throw new ConflictError('The draft has a newer revision');

    const document = migrateDocument(input.document).document;
    const checksum = await checksumDocument(document);
    const now = new Date().toISOString();
    const checkoutHash = input.checkoutToken ? await hashToken(input.checkoutToken) : null;
    if (checksum === current.revision.checksum && !additionalStatements.length) {
      try {
        await this.commit(input.actor, [
          this.saveGuard(current, input, checkoutHash),
          this.idempotencyStatement(
            'draft.save',
            input.idempotencyKey,
            input.actor,
            requestHash,
            200,
            JSON.stringify(current),
            now,
          ),
        ]);
      } catch (error) {
        const replay = await this.replayAfterSaveRace(error, input, requestHash);
        if (replay) return replay;
        throw error;
      }
      return current;
    }
    const assetStatements =
      (await this.assets?.prepareSave({
        draftId: input.draftId,
        previousDocument: current.document,
        document,
        actor: input.actor,
        now,
        preparedSourcePaths,
      })) ?? [];
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
      actionCategory: input.action.category,
      actionContext: input.action.context,
    };
    const record: DraftRecord = {
      ...current,
      latestRevisionId: revisionId,
      document,
      revision,
      updatedAt: now,
    };
    const revisionInsert = checkoutHash
      ? this.database
          .prepare(
            `INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at,action_category,action_context)
             SELECT ?, d.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM drafts d
             JOIN draft_checkouts c ON c.draft_id=d.id
             WHERE d.id=? AND d.latest_revision_id=? AND d.status='active' AND lower(c.actor)=lower(?)
               AND c.token_hash=? AND c.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
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
            revision.actionCategory,
            revision.actionContext,
            current.id,
            current.revision.id,
            input.actor,
            checkoutHash,
          )
      : this.database
          .prepare(
            `INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at,action_category,action_context) SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM drafts WHERE id = ? AND latest_revision_id = ? AND status='active'`,
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
            revision.actionCategory,
            revision.actionContext,
            current.id,
            current.revision.id,
          );
    try {
      const [, revisionWrite] = await this.commit(input.actor, [
        this.saveGuard(current, input, checkoutHash),
        revisionInsert,
        ...new D1LibraryProjection(this.database).statements(revision, current.revision.sequence),
        ...assetStatements,
        ...additionalStatements,
        this.database
          .prepare(
            `UPDATE drafts SET latest_revision_id = ?, updated_at = ? WHERE id = ? AND latest_revision_id = ? AND EXISTS (SELECT 1 FROM revisions WHERE id = ?)`,
          )
          .bind(revisionId, now, current.id, current.revision.id, revisionId),
        this.guardedAuditStatement(
          input.actor,
          'draft.save',
          current.id,
          input.requestId,
          {
            sequence: revision.sequence,
            actionCategory: input.action.category,
            actionContext: input.action.context,
          },
          revisionId,
        ),
        this.guardedIdempotencyStatement(
          'draft.save',
          input.idempotencyKey,
          input.actor,
          requestHash,
          200,
          JSON.stringify(record),
          now,
          revisionId,
        ),
      ]);
      if ((revisionWrite?.meta.changes ?? 0) !== 1) {
        if (input.checkoutToken)
          await this.assertCheckout(input.draftId, input.actor, input.checkoutToken);
        throw new ConflictError('The draft has a newer revision');
      }
      return record;
    } catch (error) {
      const replay = await this.replayAfterSaveRace(error, input, requestHash);
      if (replay) return replay;
      throw error;
    }
  }

  private saveGuard(
    current: DraftRecord,
    input: SaveDraftInput,
    checkoutHash: string | null,
  ): D1PreparedStatement {
    // Invalid JSON aborts the transaction before any queued Library, asset or receipt writes.
    return this.database
      .prepare(
        `SELECT json(CASE WHEN EXISTS (
      SELECT 1 FROM drafts d WHERE d.id=? AND d.latest_revision_id=? AND d.status='active'
      AND (? IS NULL OR EXISTS (SELECT 1 FROM draft_checkouts c WHERE c.draft_id=d.id
        AND lower(c.actor)=lower(?) AND c.token_hash=? AND c.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    ) THEN 'true' ELSE 'draft-write-conflict' END)`,
      )
      .bind(current.id, current.revision.id, checkoutHash, input.actor, checkoutHash);
  }

  private async replayAfterSaveRace(
    error: unknown,
    input: SaveDraftInput,
    requestHash: string,
  ): Promise<DraftRecord | null> {
    if (
      !(error instanceof Error) ||
      (!error.message.includes('malformed JSON') &&
        !error.message.includes('UNIQUE constraint failed: idempotency_keys'))
    )
      return null;
    if (input.checkoutToken)
      await this.assertCheckout(input.draftId, input.actor, input.checkoutToken);
    if ((await this.getDraft(input.draftId)).status !== 'active')
      throw new ConflictError('Only active drafts can be saved');
    const prior = await this.readIdempotent('draft.save', input, requestHash);
    if (prior) return prior;
    throw new ConflictError('The draft has a newer revision or checkout changed');
  }

  async listRevisions(draftId: string): Promise<RevisionRecord[]> {
    const result = await this.database
      .prepare(
        `SELECT r.id, r.draft_id, r.sequence, r.parent_revision_id, r.checksum, r.document_json,
        COALESCE((SELECT rl.label FROM revision_labels rl WHERE rl.revision_id = r.id ORDER BY rl.created_at DESC, rl.id DESC LIMIT 1), r.label) AS label,
        r.schema_version, r.renderer_version, r.created_by, r.created_at,
        r.action_category, r.action_context
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
      action: { category: 'restore', context: 'revision-history' },
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
    if ((await this.getDraft(draftId)).status !== 'active')
      throw new ConflictError('Only active drafts can be edited');
    const source = await this.database
      .prepare('SELECT * FROM revisions WHERE id = ? AND draft_id = ?')
      .bind(revisionId, draftId)
      .first<RevisionRow>();
    if (!source) throw new NotFoundError(`Revision ${revisionId} was not found`);
    await this.commit(actor, [
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
    if (current.status !== 'active') throw new ConflictError('Only active drafts can be renamed');
    const now = new Date().toISOString();
    await this.commit(actor, [
      this.database
        .prepare('UPDATE drafts SET name = ?, updated_at = ? WHERE id = ? AND status = ?')
        .bind(name, now, draftId, 'active'),
      this.auditStatement(actor, 'draft.rename', draftId, requestId, {}),
    ]);
    return { ...current, name, updatedAt: now };
  }

  async setDraftStatus(
    draftId: string,
    status: Exclude<DraftStatus, 'deleted'>,
    actor: string,
    requestId: string,
  ): Promise<DraftRecord> {
    const current = await this.getDraft(draftId);
    if (current.status === status) return current;
    const allowed =
      (current.status === 'active' && status === 'archived') ||
      (current.status === 'archived' && status === 'active');
    if (!allowed) throw new ConflictError(`Cannot change ${current.status} draft to ${status}`);
    const now = new Date().toISOString();
    const deletedAt = null;
    await this.commit(actor, [
      this.database
        .prepare(
          `UPDATE drafts SET status = ?, updated_at = ?, deleted_at = ? WHERE id = ? AND status = ?`,
        )
        .bind(status, now, deletedAt, draftId, current.status),
      ...(status === 'archived'
        ? [
            this.database.prepare('DELETE FROM draft_checkouts WHERE draft_id=?').bind(draftId),
            this.database.prepare('DELETE FROM editor_view_states WHERE draft_id=?').bind(draftId),
          ]
        : []),
      this.auditStatement(actor, `draft.${status}`, draftId, requestId, {
        previousStatus: current.status,
      }),
    ]);
    return { ...current, status, updatedAt: now, deletedAt };
  }

  async purgeDraft(
    draftId: string,
    actor: string,
    requestId: string,
  ): Promise<DeletedDraftReceipt> {
    const current = await this.getDraft(draftId);
    if (current.status !== 'archived')
      throw new ConflictError('Only archived drafts can be deleted');
    const now = new Date().toISOString();
    const activePublication = await this.database
      .prepare(
        `SELECT id FROM publish_jobs WHERE json_extract(candidate_json,'$.draftId')=?
         AND status IN ('queued','running') AND lease_expires_at>? LIMIT 1`,
      )
      .bind(draftId, now)
      .first();
    if (activePublication)
      throw new ConflictError('Wait for the active publication before deleting this draft');
    const revisions = await this.database
      .prepare('SELECT id FROM revisions WHERE draft_id=? ORDER BY sequence DESC')
      .bind(draftId)
      .all<{ id: string }>();
    try {
      await this.commit(actor, [
        // The CHECK constraint aborts the entire batch if lifecycle or lease state changed.
        this.database
          .prepare(
            `UPDATE drafts SET status=CASE WHEN status='archived' AND NOT EXISTS (
             SELECT 1 FROM publish_jobs WHERE json_extract(candidate_json,'$.draftId')=drafts.id
             AND status IN ('queued','running') AND lease_expires_at>?
           ) THEN 'deleted' ELSE 'purge-blocked' END,deleted_at=?,latest_revision_id=NULL WHERE id=?`,
          )
          .bind(now, now, draftId),
        this.database
          .prepare(
            `UPDATE idempotency_keys SET status_code=410,response_json='{"deleted":true}',
           expires_at='9999-12-31T23:59:59.999Z' WHERE json_extract(response_json,'$.id')=?`,
          )
          .bind(draftId),
        this.database.prepare('DELETE FROM publish_preflights WHERE draft_id=?').bind(draftId),
        this.database.prepare('DELETE FROM draft_checkouts WHERE draft_id=?').bind(draftId),
        this.database.prepare('DELETE FROM editor_view_states WHERE draft_id=?').bind(draftId),
        ...(this.assets?.purgeStatements(draftId) ?? []),
        this.database
          .prepare(
            `DELETE FROM audit_events WHERE target_id=? OR json_extract(metadata_json,'$.draftId')=?
           OR target_id IN (SELECT id FROM revisions WHERE draft_id=?)`,
          )
          .bind(draftId, draftId, draftId),
        this.database
          .prepare(
            'DELETE FROM revision_labels WHERE revision_id IN (SELECT id FROM revisions WHERE draft_id=?)',
          )
          .bind(draftId),
        // Delete children first: nulling a surviving child's parent would violate revision immutability.
        ...revisions.results.map(({ id }) =>
          this.database
            .prepare('DELETE FROM revisions WHERE id=? AND draft_id=?')
            .bind(id, draftId),
        ),
        this.database.prepare('DELETE FROM drafts WHERE id=?').bind(draftId),
        this.auditStatement(actor, 'draft.deleted', draftId, requestId, {}),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('draft asset migration incomplete'))
        throw new ConflictError(
          'Draft media migration is still running; deletion is unavailable until all private copies are verified',
        );
      if (error instanceof Error && error.message.includes('CHECK constraint failed'))
        throw new ConflictError('Draft state changed or a publication is active; try again');
      throw error;
    }
    return { id: draftId, status: 'deleted', deletedAt: now };
  }

  async listCheckoutAvailability(
    actor: string,
    now = new Date().toISOString(),
  ): Promise<DraftCheckoutAvailability[]> {
    const result = await this.database
      .prepare(
        `SELECT d.id AS draft_id, c.actor, c.expires_at
         FROM drafts d LEFT JOIN draft_checkouts c ON c.draft_id = d.id AND c.expires_at > ?
         WHERE d.status != 'deleted' ORDER BY d.updated_at DESC LIMIT 100`,
      )
      .bind(now)
      .all<{ draft_id: string; actor: string | null; expires_at: string | null }>();
    return result.results.map((row) => ({
      draftId: row.draft_id,
      state: !row.actor
        ? 'available'
        : row.actor.toLowerCase() === actor.toLowerCase()
          ? 'owned'
          : 'unavailable',
      expiresAt: row.expires_at,
    }));
  }

  async acquireCheckout(input: AcquireCheckoutCommand): Promise<DraftCheckout> {
    const draft = await this.getDraft(input.draftId);
    if (draft.status !== 'active') throw new ConflictError('Only active drafts can be checked out');
    const now = input.now ?? new Date().toISOString();
    const prior = await this.checkoutRow(input.draftId);
    const token = crypto.randomUUID();
    const tokenHash = await hashToken(token);
    if (input.resumeOnly) {
      if (!prior) throw new ConflictError('There is no current checkout to resume');
      const [resumed] = await this.commit(input.actor, [
        this.database
          .prepare(
            `UPDATE draft_checkouts SET token_hash=?,updated_at=? WHERE draft_id=? AND token_hash=?
         AND lower(actor)=lower(?) AND client_id=? AND expires_at>COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         AND EXISTS (SELECT 1 FROM drafts WHERE id=draft_checkouts.draft_id AND status='active')`,
          )
          .bind(
            tokenHash,
            now,
            input.draftId,
            prior.token_hash,
            input.actor,
            input.clientId,
            input.now ?? null,
          ),
      ]);
      if (resumed?.meta.changes !== 1)
        throw new ConflictError('This editing client no longer owns the draft checkout');
      await this.auditStatement(
        input.actor,
        'draft.checkout.resumed',
        input.draftId,
        input.requestId,
        {},
      ).run();
      return {
        draftId: input.draftId,
        actor: input.actor,
        clientId: input.clientId,
        token,
        acquiredAt: prior.acquired_at,
        lastActivityAt: prior.last_activity_at,
        expiresAt: prior.expires_at,
        event: 'resumed',
        viewState: await this.readViewState(input.actor),
      };
    }
    const expiresAt = checkoutExpiry(now);
    const event =
      !prior || prior.expires_at <= now
        ? 'acquired'
        : prior.client_id === input.clientId
          ? 'resumed'
          : 'transferred';
    const acquiredAt = event === 'acquired' ? now : prior!.acquired_at;
    const [result] = await this.commit(input.actor, [
      this.database
        .prepare(
          `INSERT INTO draft_checkouts (draft_id,actor,client_id,token_hash,acquired_at,last_activity_at,expires_at,updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM drafts WHERE id=? AND status='active'
         ON CONFLICT(draft_id) DO UPDATE SET actor=excluded.actor, client_id=excluded.client_id,
           token_hash=excluded.token_hash, acquired_at=excluded.acquired_at,
           last_activity_at=excluded.last_activity_at, expires_at=excluded.expires_at, updated_at=excluded.updated_at
         WHERE draft_checkouts.expires_at <= ? OR lower(draft_checkouts.actor) = lower(?)`,
        )
        .bind(
          input.draftId,
          input.actor,
          input.clientId,
          tokenHash,
          acquiredAt,
          now,
          expiresAt,
          now,
          input.draftId,
          now,
          input.actor,
        ),
    ]);
    if ((result?.meta.changes ?? 0) !== 1) {
      await this.auditStatement(
        input.actor,
        'draft.checkout.denied',
        input.draftId,
        input.requestId,
        {},
      ).run();
      throw new ConflictError('This draft is already checked out');
    }
    if (prior && prior.expires_at <= now)
      await this.auditStatement(
        prior.actor,
        'draft.checkout.expired',
        input.draftId,
        input.requestId,
        {},
      ).run();
    await this.auditStatement(
      input.actor,
      `draft.checkout.${event}`,
      input.draftId,
      input.requestId,
      {},
    ).run();
    return {
      draftId: input.draftId,
      actor: input.actor,
      clientId: input.clientId,
      token,
      acquiredAt,
      lastActivityAt: now,
      expiresAt,
      event,
      viewState: await this.readViewState(input.actor),
    };
  }

  async touchCheckout(input: CheckoutCommand, viewState?: EditorViewState): Promise<DraftCheckout> {
    const now = input.now ?? new Date().toISOString();
    const tokenHash = await hashToken(input.token);
    const expiresAt = checkoutExpiry(now);
    const statements = [
      this.database
        .prepare(
          `SELECT json(CASE WHEN EXISTS (
      SELECT 1 FROM draft_checkouts c JOIN drafts d ON d.id=c.draft_id
      WHERE c.draft_id=? AND lower(c.actor)=lower(?) AND c.client_id=? AND c.token_hash=?
        AND c.expires_at>COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND d.status='active'
    ) THEN 'true' ELSE 'checkout-write-conflict' END)`,
        )
        .bind(input.draftId, input.actor, input.clientId, tokenHash, input.now ?? null),
    ];
    if (input.activity !== false)
      statements.push(
        this.database
          .prepare(
            'UPDATE draft_checkouts SET last_activity_at=?,expires_at=?,updated_at=? WHERE draft_id=?',
          )
          .bind(now, expiresAt, now, input.draftId),
      );
    if (viewState) {
      statements.push(
        this.database
          .prepare(
            `INSERT INTO editor_view_states (actor,draft_id,panel,page_id,selected_element_id,preview_viewport,preview_zoom,scroll_positions_json,updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(actor) DO UPDATE SET draft_id=excluded.draft_id,panel=excluded.panel,page_id=excluded.page_id,
             selected_element_id=excluded.selected_element_id,preview_viewport=excluded.preview_viewport,
             preview_zoom=excluded.preview_zoom,scroll_positions_json=excluded.scroll_positions_json,updated_at=excluded.updated_at
           WHERE editor_view_states.draft_id IS NOT excluded.draft_id OR editor_view_states.panel IS NOT excluded.panel
             OR editor_view_states.page_id IS NOT excluded.page_id OR editor_view_states.selected_element_id IS NOT excluded.selected_element_id
             OR editor_view_states.preview_viewport IS NOT excluded.preview_viewport OR editor_view_states.preview_zoom IS NOT excluded.preview_zoom
             OR editor_view_states.scroll_positions_json IS NOT excluded.scroll_positions_json`,
          )
          .bind(
            input.actor,
            input.draftId,
            viewState.panel,
            viewState.pageId,
            viewState.selectedElementId,
            viewState.previewViewport,
            viewState.previewZoom,
            canonicalize(viewState.scrollPositions),
            now,
          ),
      );
    }
    try {
      await this.commit(input.actor, statements);
    } catch (error) {
      if (error instanceof Error && error.message.includes('malformed JSON'))
        throw new ConflictError('This editing client no longer owns the draft checkout');
      throw error;
    }
    const row = await this.checkoutRow(input.draftId);
    if (!row || row.client_id !== input.clientId || row.token_hash !== tokenHash)
      throw new ConflictError('This editing client no longer owns the draft checkout');
    return {
      draftId: input.draftId,
      actor: input.actor,
      clientId: input.clientId,
      token: input.token,
      acquiredAt: row.acquired_at,
      lastActivityAt: row.last_activity_at,
      expiresAt: row.expires_at,
      event: 'resumed',
      viewState: await this.readViewState(input.actor),
    };
  }

  async releaseCheckout(input: CheckoutCommand): Promise<void> {
    const tokenHash = await hashToken(input.token);
    const [result] = await this.commit(input.actor, [
      this.database
        .prepare(
          `DELETE FROM draft_checkouts WHERE draft_id = ? AND lower(actor) = lower(?) AND client_id = ? AND token_hash = ?`,
        )
        .bind(input.draftId, input.actor, input.clientId, tokenHash),
    ]);
    if ((result?.meta.changes ?? 0) === 1)
      await this.auditStatement(
        input.actor,
        'draft.checkout.released',
        input.draftId,
        input.requestId,
        {},
      ).run();
  }

  async assertCheckout(draftId: string, actor: string, token: string, now?: string): Promise<void> {
    const tokenHash = await hashToken(token);
    const row = await this.database
      .prepare(
        `SELECT 1 AS valid FROM draft_checkouts c JOIN drafts d ON d.id = c.draft_id
         JOIN user_roles u ON u.email=c.actor AND u.active=1 AND u.role IN ('editor','publisher','administrator')
       WHERE c.draft_id = ? AND lower(c.actor) = lower(?) AND c.token_hash = ?
         AND c.expires_at > COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND d.status = 'active'`,
      )
      .bind(draftId, actor, tokenHash, now ?? null)
      .first<{ valid: number }>();
    if (!row) {
      await this.assertEditor(actor);
      throw new ConflictError('This editing client no longer owns the draft checkout');
    }
  }

  async ownedCheckout(
    actor: string,
    now = new Date().toISOString(),
  ): Promise<DraftCheckout | null> {
    const row = await this.database
      .prepare(
        `SELECT c.* FROM draft_checkouts c JOIN drafts d ON d.id=c.draft_id
       WHERE lower(c.actor)=lower(?) AND c.expires_at > ? AND d.status='active' ORDER BY c.updated_at DESC LIMIT 1`,
      )
      .bind(actor, now)
      .first<CheckoutRow>();
    return row
      ? {
          draftId: row.draft_id,
          actor: row.actor,
          clientId: row.client_id,
          token: '',
          acquiredAt: row.acquired_at,
          lastActivityAt: row.last_activity_at,
          expiresAt: row.expires_at,
          event: 'resumed',
          viewState: await this.readViewState(actor),
        }
      : null;
  }

  private checkoutRow(draftId: string): Promise<CheckoutRow | null> {
    return this.database
      .prepare('SELECT * FROM draft_checkouts WHERE draft_id = ?')
      .bind(draftId)
      .first<CheckoutRow>();
  }

  private async readViewState(actor: string): Promise<EditorViewState | null> {
    const row = await this.database
      .prepare('SELECT * FROM editor_view_states WHERE lower(actor)=lower(?)')
      .bind(actor)
      .first<ViewStateRow>();
    return row
      ? {
          draftId: row.draft_id,
          panel: row.panel,
          pageId: row.page_id,
          selectedElementId: row.selected_element_id,
          previewViewport: row.preview_viewport,
          previewZoom: row.preview_zoom,
          scrollPositions: JSON.parse(row.scroll_positions_json) as Record<string, number>,
          updatedAt: row.updated_at,
        }
      : null;
  }

  private async readIdempotent(
    scope: string,
    input: CreateDraftInput | SaveDraftInput,
    requestHash: string,
  ): Promise<DraftRecord | null> {
    const row = await this.database
      .prepare(
        `SELECT response_json,status_code,request_hash,request_version,expires_at FROM idempotency_keys WHERE scope = ? AND actor = ? AND idempotency_key = ?`,
      )
      .bind(scope, input.actor, input.idempotencyKey)
      .first<{
        response_json: string;
        status_code: number;
        request_hash: string;
        request_version: number;
        expires_at: string;
      }>();
    if (row?.status_code === 410) {
      if (scope === 'draft.create')
        throw new ConflictError('This request belongs to a permanently deleted draft');
      throw new NotFoundError('This request belongs to a permanently deleted draft');
    }
    if (!row) return null;
    await this.assertEditor(input.actor);
    if (row.expires_at <= new Date().toISOString())
      throw new ConflictError(
        'This request receipt expired; reload and reconcile the saved revision',
      );
    const record = JSON.parse(row.response_json) as DraftRecord;
    if (row.request_version === 1) {
      if ('sourceDraftId' in input && input.sourceDraftId)
        throw new ConflictError(
          'This legacy copy request requires reconciliation with the saved draft',
        );
      const document = migrateDocument(input.document).document;
      requestHash = await checksumDocument(
        'draftId' in input
          ? {
              draftId: input.draftId,
              expectedChecksum: input.expectedChecksum,
              document,
              action: input.action,
            }
          : { name: input.name, document },
      );
      if (
        'draftId' in input &&
        (record.id !== input.draftId ||
          (input.label ?? null) !== record.revision.label ||
          (input.expectedRevisionId &&
            input.expectedRevisionId !== record.revision.parentRevisionId))
      )
        throw new ConflictError('This request identity was already used with different input');
    }
    if (row.request_hash !== requestHash)
      throw new ConflictError('This request identity was already used with different input');
    return record;
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
    const expires = new Date(Date.parse(now) + 90 * 86_400_000).toISOString();
    return this.database
      .prepare(
        `INSERT INTO idempotency_keys (scope,idempotency_key,actor,request_hash,status_code,response_json,created_at,expires_at,request_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2)`,
      )
      .bind(scope, key, actor, requestHash, statusCode, responseJson, now, expires);
  }

  private guardedIdempotencyStatement(
    scope: string,
    key: string,
    actor: string,
    requestHash: string,
    statusCode: number,
    responseJson: string,
    now: string,
    revisionId: string,
  ): D1PreparedStatement {
    const expires = new Date(Date.parse(now) + 90 * 86_400_000).toISOString();
    return this.database
      .prepare(
        `INSERT INTO idempotency_keys (scope,idempotency_key,actor,request_hash,status_code,response_json,created_at,expires_at,request_version)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 2 WHERE EXISTS (SELECT 1 FROM revisions WHERE id = ?)`,
      )
      .bind(scope, key, actor, requestHash, statusCode, responseJson, now, expires, revisionId);
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

  private guardedAuditStatement(
    actor: string,
    action: string,
    targetId: string,
    requestId: string,
    metadata: AuditEventRecord['metadata'],
    revisionId: string,
  ): D1PreparedStatement {
    return this.database
      .prepare(
        `INSERT INTO audit_events (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
         SELECT ?, ?, ?, ?, 'draft', ?, 'succeeded', ?, ? WHERE EXISTS (SELECT 1 FROM revisions WHERE id = ?)`,
      )
      .bind(
        crypto.randomUUID(),
        new Date().toISOString(),
        actor,
        action,
        targetId,
        requestId,
        JSON.stringify(metadata),
        revisionId,
      );
  }
}

interface CheckoutRow {
  draft_id: string;
  actor: string;
  client_id: string;
  token_hash: string;
  acquired_at: string;
  last_activity_at: string;
  expires_at: string;
  updated_at: string;
}
interface ViewStateRow {
  actor: string;
  draft_id: string;
  panel: EditorViewState['panel'];
  page_id: string | null;
  selected_element_id: string | null;
  preview_viewport: EditorViewState['previewViewport'];
  preview_zoom: number;
  scroll_positions_json: string;
  updated_at: string;
}
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
