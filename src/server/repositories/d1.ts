import { prepareRevisionPayload, readRevisionDocument } from './revision-payloads';
import {
  REVISION_PAGE_SIZE,
  type RevisionListOptions,
  type RevisionSummary,
  type DraftSummary,
} from './contracts';
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
  DraftMutationProof,
  DraftCheckout,
  DraftCheckoutAvailability,
  EditorViewState,
  DraftRepository,
  DraftStatus,
  RestoreRevisionInput,
  RevisionRecord,
  SaveDraftInput,
  ProductionDraftSource,
  DraftPublicationStatus,
} from './contracts';
import { ConflictError, NotFoundError } from './memory';
import { createRequestHash, saveRequestHash } from './request-hash';
import { AuthorizationError } from '../auth/roles';
import type { D1DeletionReceipts } from '../maintenance/deletion-receipts';
import { draftDeletionStatements } from '../maintenance/draft-deletion';
import { ApiError } from '../http/errors';

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
  publication_source_target: DraftPublicationStatus['sourceTarget'] | null;
  baseline_release_id: string | null;
  baseline_sequence: number | null;
  current_release_id: string | null;
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

const DRAFT_FIELDS = `d.id, d.site_id, d.name, d.status, d.latest_revision_id,
    d.created_by, d.created_at, d.updated_at, d.deleted_at,
    r.id AS revision_id, r.sequence, r.parent_revision_id, r.checksum,
    COALESCE((SELECT rl.label FROM revision_labels rl WHERE rl.revision_id = r.id ORDER BY rl.created_at DESC, rl.id DESC LIMIT 1), r.label) AS label,
    r.schema_version, r.renderer_version,
    r.created_by AS revision_created_by, r.created_at AS revision_created_at,
    r.action_category, r.action_context,
    b.source_target AS publication_source_target,b.baseline_release_id,b.baseline_sequence,
    (SELECT id FROM current_publication_releases ORDER BY sequence DESC LIMIT 1) AS current_release_id`;
const DRAFT_FROM = ` FROM drafts d
  JOIN revisions r ON r.id = d.latest_revision_id
  LEFT JOIN draft_publication_baselines b ON b.draft_id=d.id
`;
const DRAFT_SELECT = `SELECT ${DRAFT_FIELDS},r.document_json ${DRAFT_FROM}`;

function revisionSummary(row: Omit<RevisionRow, 'document_json'>): RevisionSummary {
  return {
    id: row.id,
    draftId: row.draft_id,
    sequence: row.sequence,
    parentRevisionId: row.parent_revision_id,
    checksum: row.checksum,
    label: row.label,
    schemaVersion: row.schema_version,
    rendererVersion: row.renderer_version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    actionCategory: row.action_category,
    actionContext: row.action_context,
  };
}

async function parseRevision(database: D1Database, row: RevisionRow): Promise<RevisionRecord> {
  const document = migrateDocument(await readRevisionDocument(database, row)).document;
  return {
    ...revisionSummary(row),
    document,
    schemaVersion: document.schemaVersion,
    rendererVersion: document.rendererVersion,
  };
}

function draftSummary(row: Omit<DraftRow, 'document_json'>): DraftSummary {
  const revision = revisionSummary({
    ...row,
    id: row.revision_id,
    draft_id: row.id,
    created_by: row.revision_created_by,
    created_at: row.revision_created_at,
  });
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    status: row.status,
    latestRevisionId: row.latest_revision_id,
    revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    publication: publicationStatus(row),
  };
}

function publicationStatus(
  row: Pick<
    DraftRow,
    | 'publication_source_target'
    | 'baseline_release_id'
    | 'baseline_sequence'
    | 'current_release_id'
    | 'sequence'
  >,
): DraftPublicationStatus {
  return {
    sourceTarget: row.publication_source_target ?? 'unknown',
    state:
      row.baseline_release_id && row.current_release_id
        ? row.baseline_release_id === row.current_release_id
          ? 'published'
          : 'behind'
        : 'unknown',
    displayCount: Math.max(0, row.sequence - (row.baseline_sequence ?? 1)),
  };
}

async function parseDraft(database: D1Database, row: DraftRow): Promise<DraftRecord> {
  const revision = await parseRevision(database, {
    ...row,
    id: row.revision_id,
    draft_id: row.id,
    created_by: row.revision_created_by,
    created_at: row.revision_created_at,
  });
  return { ...draftSummary(row), document: revision.document, revision };
}

export class D1DraftRepository implements DraftRepository {
  constructor(
    private readonly database: D1Database,
    private readonly assets?: D1DraftAssets,
    private readonly storageFormat: 'legacy' | 'compact-v1' = 'legacy',
    private readonly deletionReceipts?: D1DeletionReceipts,
    private readonly productionSource?: (
      target: 'staging' | 'production',
    ) => Promise<ProductionDraftSource>,
    private readonly defaultPublicationSource = true,
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
      ? `${DRAFT_SELECT} WHERE d.status=? ORDER BY d.updated_at DESC LIMIT 100`
      : `${DRAFT_SELECT} WHERE d.status!='deleted' ORDER BY d.updated_at DESC LIMIT 100`;
    const result = await (
      status ? this.database.prepare(query).bind(status) : this.database.prepare(query)
    ).all<DraftRow>();
    return Promise.all(result.results.map((row) => parseDraft(this.database, row)));
  }

  async listDraftSummaries(status?: DraftStatus): Promise<DraftSummary[]> {
    const select = `SELECT ${DRAFT_FIELDS} ${DRAFT_FROM}`;
    const query = status
      ? `${select} WHERE d.status = ? ORDER BY d.updated_at DESC LIMIT 100`
      : `${select} WHERE d.status != 'deleted' ORDER BY d.updated_at DESC LIMIT 100`;
    const statement = status
      ? this.database.prepare(query).bind(status)
      : this.database.prepare(query);
    const result = await statement.all<Omit<DraftRow, 'document_json'>>();
    return result.results.map(draftSummary);
  }

  async getDraft(id: string): Promise<DraftRecord> {
    const row = await this.database
      .prepare(`${DRAFT_SELECT} WHERE d.id = ?`)
      .bind(id)
      .first<DraftRow>();
    if (!row) throw new NotFoundError(`Draft ${id} was not found`);
    return parseDraft(this.database, row);
  }

  async getPublicationStatus(id: string): Promise<DraftPublicationStatus> {
    const row = await this.database
      .prepare(
        `SELECT r.sequence,b.source_target AS publication_source_target,
      b.baseline_release_id,b.baseline_sequence,
      (SELECT id FROM current_publication_releases ORDER BY sequence DESC LIMIT 1) AS current_release_id
      FROM drafts d JOIN revisions r ON r.id=d.latest_revision_id
      LEFT JOIN draft_publication_baselines b ON b.draft_id=d.id WHERE d.id=?`,
      )
      .bind(id)
      .first<
        Pick<
          DraftRow,
          | 'sequence'
          | 'publication_source_target'
          | 'baseline_release_id'
          | 'baseline_sequence'
          | 'current_release_id'
        >
      >();
    if (!row) throw new NotFoundError(`Draft ${id} was not found`);
    return publicationStatus(row);
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
    return parseRevision(this.database, row);
  }

  async createDraft(input: CreateDraftInput): Promise<DraftRecord> {
    if (input.sourceTarget && !this.productionSource)
      throw new ApiError(
        503,
        'PUBLICATION_SOURCE_UNAVAILABLE',
        'Selected publication is unavailable. No draft was created.',
      );
    const importProduction =
      this.productionSource &&
      !input.sourceDraftId &&
      (Boolean(input.sourceTarget) || this.defaultPublicationSource);
    const target = input.sourceTarget ?? 'production';
    const requestHash = importProduction
      ? await checksumDocument({ name: input.name, source: target })
      : await createRequestHash(input);
    const prior = await this.readIdempotent('draft.create', input, requestHash);
    if (prior) return prior;

    await this.assertEditor(input.actor);
    const source = importProduction ? await this.productionSource(target) : undefined;
    if (
      input.expectedSource &&
      (!source ||
        Object.entries(input.expectedSource).some(
          ([key, value]) => source.provenance[key as keyof typeof input.expectedSource] !== value,
        ))
    )
      throw new ApiError(
        409,
        'PUBLICATION_SOURCE_CHANGED',
        'Selected publication changed. No draft was created; refresh the source and try again.',
      );

    const now = new Date().toISOString();
    const draftId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const prepared = this.assets
      ? await this.assets.prepareCreate({
          draftId,
          document: migrateDocument(source?.document ?? input.document).document,
          sourceDraftId: input.sourceDraftId,
          sourceObjects: source?.assets,
          actor: input.actor,
          now,
        })
      : { document: migrateDocument(source?.document ?? input.document).document, statements: [] };
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
    const payload =
      this.storageFormat === 'compact-v1'
        ? await prepareRevisionPayload(this.database, record.revision)
        : { documentJson: JSON.stringify(document), statements: [] };
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
        ...(source
          ? [
              this.database
                .prepare(
                  'INSERT INTO draft_production_sources(draft_id,provenance_json) VALUES (?,?)',
                )
                .bind(draftId, JSON.stringify(source.provenance)),
              this.database
                .prepare(
                  `INSERT INTO draft_publication_baselines
                  (draft_id,source_target,baseline_release_id,baseline_sequence)
                  VALUES (?,?,(
                    SELECT id FROM current_publication_releases p
                    WHERE ((
                      ?='production' AND p.id=(SELECT id FROM current_publication_releases ORDER BY sequence DESC LIMIT 1)
                      AND COALESCE(json_extract(p.source_json,'$.commitSha'),json_extract(p.source_json,'$.sourceRevision'))=?
                      AND json_extract(p.evidence_json,'$.deploymentId')=?
                    ) OR (
                      ?='staging' AND p.kind IN ('publication','rollback')
                      AND json_extract(p.source_json,'$.candidateChecksum')=?
                    )) AND p.artifact_digest=?
                    ORDER BY p.sequence DESC LIMIT 1
                  ),1)`,
                )
                .bind(
                  draftId,
                  source.provenance.target ?? target,
                  target,
                  source.provenance.sourceCommit,
                  source.provenance.deploymentId,
                  target,
                  source.provenance.candidateChecksum ?? '',
                  source.provenance.artifactDigest,
                ),
            ]
          : []),
        this.database
          .prepare(
            `INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at,action_category,action_context) VALUES (?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            revisionId,
            draftId,
            checksum,
            payload.documentJson,
            record.revision.label,
            document.schemaVersion,
            document.rendererVersion,
            input.actor,
            now,
            record.revision.actionCategory,
            record.revision.actionContext,
          ),
        ...payload.statements,
        this.database
          .prepare(`UPDATE drafts SET latest_revision_id = ? WHERE id = ?`)
          .bind(revisionId, draftId),
        ...new D1LibraryProjection(this.database).statements(record.revision, 0),
        this.auditStatement(input.actor, 'draft.create', draftId, input.requestId, {
          revisionId,
          sequence: 1,
          ...(source?.provenance ?? {}),
        }),
        this.idempotencyStatement(
          'draft.create',
          input.idempotencyKey,
          input.actor,
          requestHash,
          201,
          record,
          now,
        ),
      ]);
      return this.getDraft(draftId);
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
    const current = await this.getDraft(input.draftId);
    await this.assertCheckout(input.draftId, input.actor, input.checkoutToken);
    if (current.status !== 'active') throw new ConflictError('Only active drafts can be saved');
    const requestHash = await saveRequestHash(input);
    const prior = await this.readIdempotent('draft.save', input, requestHash);
    if (prior) return prior;
    if (input.expectedRevisionId !== current.revision.id)
      throw new ConflictError('The draft has a newer revision');
    if (current.revision.checksum !== input.expectedChecksum)
      throw new ConflictError('The draft has a newer revision');

    const document = migrateDocument(input.document).document;
    const checksum = await checksumDocument(document);
    const now = new Date().toISOString();
    const checkoutHash = await hashToken(input.checkoutToken);
    if (checksum === current.revision.checksum && !additionalStatements.length) {
      try {
        await this.commit(input.actor, [
          this.mutationGuard(current, input.actor, checkoutHash),
          this.idempotencyStatement(
            'draft.save',
            input.idempotencyKey,
            input.actor,
            requestHash,
            200,
            current,
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
    const payload =
      this.storageFormat === 'compact-v1'
        ? await prepareRevisionPayload(this.database, revision)
        : { documentJson: JSON.stringify(document), statements: [] };
    const revisionInsert = this.database
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
        payload.documentJson,
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
      );
    try {
      const [, revisionWrite] = await this.commit(input.actor, [
        this.mutationGuard(current, input.actor, checkoutHash),
        revisionInsert,
        ...payload.statements,
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
        this.idempotencyStatement(
          'draft.save',
          input.idempotencyKey,
          input.actor,
          requestHash,
          200,
          record,
          now,
          revisionId,
        ),
      ]);
      if ((revisionWrite?.meta.changes ?? 0) !== 1) {
        await this.assertCheckout(input.draftId, input.actor, input.checkoutToken);
        throw new ConflictError('The draft has a newer revision');
      }
      return this.getDraft(input.draftId);
    } catch (error) {
      const replay = await this.replayAfterSaveRace(error, input, requestHash);
      if (replay) return replay;
      throw error;
    }
  }

  private mutationGuard(
    current: DraftRecord,
    actor: string,
    checkoutHash: string,
  ): D1PreparedStatement {
    // Invalid JSON aborts the transaction before any queued Library, asset or receipt writes.
    return this.database
      .prepare(
        `SELECT json(CASE WHEN EXISTS (
      SELECT 1 FROM drafts d WHERE d.id=? AND d.latest_revision_id=? AND d.status=?
      AND EXISTS (SELECT 1 FROM draft_checkouts c WHERE c.draft_id=d.id
        AND lower(c.actor)=lower(?) AND c.token_hash=? AND c.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) THEN 'true' ELSE 'draft-write-conflict' END)`,
      )
      .bind(current.id, current.revision.id, current.status, actor, checkoutHash);
  }

  private async prepareMetadataMutation(draftId: string, actor: string, proof: DraftMutationProof) {
    const current = await this.getDraft(draftId);
    if (
      current.latestRevisionId !== proof.expectedRevisionId ||
      current.revision.checksum !== proof.expectedChecksum
    )
      throw new ConflictError('The draft has a newer revision');
    return {
      current,
      guard: this.mutationGuard(current, actor, await hashToken(proof.checkoutToken)),
    };
  }

  private async commitMetadata(
    actor: string,
    guard: D1PreparedStatement,
    statements: D1PreparedStatement[],
  ): Promise<void> {
    try {
      await this.commit(actor, [guard, ...statements]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('malformed JSON'))
        throw new ConflictError(
          'The draft changed or this editing client no longer owns its checkout',
        );
      throw error;
    }
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
    await this.assertCheckout(input.draftId, input.actor, input.checkoutToken);
    if ((await this.getDraft(input.draftId)).status !== 'active')
      throw new ConflictError('Only active drafts can be saved');
    const prior = await this.readIdempotent('draft.save', input, requestHash);
    if (prior) return prior;
    throw new ConflictError('The draft has a newer revision or checkout changed');
  }

  async listRevisions(
    draftId: string,
    options: RevisionListOptions = {},
  ): Promise<RevisionSummary[]> {
    const draft = await this.database
      .prepare('SELECT latest_revision_id FROM drafts WHERE id=?')
      .bind(draftId)
      .first<{ latest_revision_id: string }>();
    if (!draft) throw new NotFoundError(`Draft ${draftId} was not found`);
    const result = await this.database
      .prepare(
        `WITH summaries AS (SELECT r.id, r.draft_id, r.sequence, r.parent_revision_id, r.checksum,
        COALESCE((SELECT rl.label FROM revision_labels rl WHERE rl.revision_id = r.id ORDER BY rl.created_at DESC, rl.id DESC LIMIT 1), r.label) AS label,
        r.schema_version, r.renderer_version, r.created_by, r.created_at,
        r.action_category, r.action_context
        FROM revisions r WHERE r.draft_id=? AND r.sequence<?)
        SELECT * FROM summaries WHERE (?!='named' OR label IS NOT NULL)
          AND (?!='current' OR id=?)
          AND (?='' OR instr(lower(COALESCE(label,'') || ' ' || sequence || ' ' || created_by),?)>0)
        ORDER BY sequence DESC LIMIT ?`,
      )
      .bind(
        draftId,
        options.beforeSequence ?? Number.MAX_SAFE_INTEGER,
        options.filter ?? 'all',
        options.filter ?? 'all',
        draft.latest_revision_id,
        options.query?.trim().toLowerCase() ?? '',
        options.query?.trim().toLowerCase() ?? '',
        REVISION_PAGE_SIZE + 1,
      )
      .all<Omit<RevisionRow, 'document_json'>>();
    return result.results.map(revisionSummary);
  }

  async restoreRevision(input: RestoreRevisionInput): Promise<DraftRecord> {
    const source = await this.database
      .prepare(`SELECT * FROM revisions WHERE id = ? AND draft_id = ?`)
      .bind(input.revisionId, input.draftId)
      .first<RevisionRow>();
    if (!source) throw new NotFoundError(`Revision ${input.revisionId} was not found`);
    return this.saveDraft({
      ...input,
      document: (await parseRevision(this.database, source)).document,
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
    proof: DraftMutationProof,
  ): Promise<RevisionRecord> {
    const { current, guard } = await this.prepareMetadataMutation(draftId, actor, proof);
    if (current.status !== 'active') throw new ConflictError('Only active drafts can be edited');
    const source = await this.database
      .prepare('SELECT * FROM revisions WHERE id = ? AND draft_id = ?')
      .bind(revisionId, draftId)
      .first<RevisionRow>();
    if (!source) throw new NotFoundError(`Revision ${revisionId} was not found`);
    await this.commitMetadata(actor, guard, [
      this.database
        .prepare(
          'INSERT INTO revision_labels (id,revision_id,label,created_by,created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(crypto.randomUUID(), revisionId, label, actor, new Date().toISOString()),
      this.auditStatement(actor, 'revision.label', revisionId, requestId, { draftId }),
    ]);
    return { ...(await parseRevision(this.database, source)), label };
  }

  async renameDraft(
    draftId: string,
    name: string,
    actor: string,
    requestId: string,
    proof: DraftMutationProof,
  ): Promise<DraftRecord> {
    const { current, guard } = await this.prepareMetadataMutation(draftId, actor, proof);
    if (current.status !== 'active') throw new ConflictError('Only active drafts can be renamed');
    const now = new Date().toISOString();
    await this.commitMetadata(actor, guard, [
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
    proof: DraftMutationProof,
  ): Promise<DraftRecord> {
    const { current, guard } = await this.prepareMetadataMutation(draftId, actor, proof);
    if (current.status === status) {
      await this.commitMetadata(actor, guard, []);
      return current;
    }
    const allowed =
      (current.status === 'active' && status === 'archived') ||
      (current.status === 'archived' && status === 'active');
    if (!allowed) throw new ConflictError(`Cannot change ${current.status} draft to ${status}`);
    const now = new Date().toISOString();
    const deletedAt = null;
    await this.commitMetadata(actor, guard, [
      this.database
        .prepare(
          `UPDATE drafts SET status = ?, updated_at = ?, deleted_at = ? WHERE id = ? AND status = ?`,
        )
        .bind(status, now, deletedAt, draftId, current.status),
      this.database.prepare('DELETE FROM draft_checkouts WHERE draft_id=?').bind(draftId),
      this.database.prepare('DELETE FROM editor_view_states WHERE draft_id=?').bind(draftId),
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
    proof: DraftMutationProof,
  ): Promise<DeletedDraftReceipt> {
    const { current, guard } = await this.prepareMetadataMutation(draftId, actor, proof);
    if (current.status !== 'archived')
      throw new ConflictError('Only archived drafts can be deleted');
    if (
      await this.database
        .prepare('SELECT 1 FROM publication_inputs WHERE draft_id=? LIMIT 1')
        .bind(draftId)
        .first()
    )
      throw new ConflictError(
        'This draft is still retained for publication or rollback and cannot be deleted yet',
      );
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
    const deletion = await this.deletionReceipts?.prepare({ kind: 'draft', draftId });
    try {
      await this.commitMetadata(actor, guard, [
        // The CHECK constraint aborts the entire batch if lifecycle or lease state changed.
        this.database
          .prepare(
            `UPDATE drafts SET status=CASE WHEN status='archived' AND NOT EXISTS (
             SELECT 1 FROM publish_jobs WHERE json_extract(candidate_json,'$.draftId')=drafts.id
             AND status IN ('queued','running') AND lease_expires_at>?
           ) AND NOT EXISTS (
             SELECT 1 FROM publication_inputs WHERE draft_id=drafts.id
           ) THEN 'deleted' ELSE 'purge-blocked' END,deleted_at=?,latest_revision_id=NULL WHERE id=?`,
          )
          .bind(now, now, draftId),
        ...draftDeletionStatements(this.database, draftId),
        ...(deletion ? [this.deletionReceipts!.proof(deletion)] : []),
        this.auditStatement(actor, 'draft.deleted', draftId, requestId, {}),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('draft asset migration incomplete'))
        throw new ConflictError(
          'Draft media migration is still running; deletion is unavailable until all private copies are verified',
        );
      if (error instanceof Error && error.message.includes('CHECK constraint failed'))
        throw new ConflictError('Draft state changed or a publication still needs it; try again');
      throw error;
    }
    if (deletion)
      await this.deletionReceipts!.confirm(deletion).catch(() => {
        // Prepared receipt and atomic commit proof let quarantined recovery settle a lost reply.
      });
    return { id: draftId, status: 'deleted', deletedAt: now };
  }

  async listCheckoutAvailability(
    actor: string,
    now = new Date().toISOString(),
  ): Promise<DraftCheckoutAvailability[]> {
    const result = await this.database
      .prepare(
        `SELECT d.id AS draft_id, c.actor, c.expires_at, u.github_login
         FROM drafts d LEFT JOIN draft_checkouts c ON c.draft_id = d.id AND c.expires_at > ?
         LEFT JOIN user_roles u ON u.email = c.actor COLLATE NOCASE
         WHERE d.status != 'deleted' ORDER BY d.updated_at DESC LIMIT 100`,
      )
      .bind(now)
      .all<{
        draft_id: string;
        actor: string | null;
        expires_at: string | null;
        github_login: string | null;
      }>();
    return result.results.map((row) => {
      const unavailable = row.actor && row.actor.toLowerCase() !== actor.toLowerCase();
      return {
        draftId: row.draft_id,
        state: !row.actor ? 'available' : unavailable ? 'unavailable' : 'owned',
        expiresAt: row.expires_at,
        ...(unavailable && row.github_login ? { ownerLogin: row.github_login } : {}),
      };
    });
  }

  async acquireCheckout(input: AcquireCheckoutCommand): Promise<DraftCheckout> {
    const draft = await this.getDraft(input.draftId);
    const expectedStatus = input.expectedStatus ?? 'active';
    if (draft.status !== expectedStatus || (input.resumeOnly && expectedStatus !== 'active'))
      throw new ConflictError('The draft status changed; refresh before continuing');
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
         SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM drafts WHERE id=? AND status=?
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
          expectedStatus,
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
        `SELECT response_json,response_version,status_code,request_hash,request_version,expires_at,expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AS expired FROM idempotency_keys WHERE scope = ? AND actor = ? AND idempotency_key = ?`,
      )
      .bind(scope, input.actor, input.idempotencyKey)
      .first<{
        response_json: string;
        response_version: number;
        expired: number;
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
    if (row.expired === 1)
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
    if (row.response_version === 2) {
      const source = await this.database
        .prepare(
          'SELECT id,draft_id,checksum,document_json FROM revisions WHERE id=? AND draft_id=?',
        )
        .bind(record.latestRevisionId, record.id)
        .first<RevisionRow>();
      if (
        !source ||
        source.id !== record.revision.id ||
        source.checksum !== record.revision.checksum
      )
        throw new Error('REQUEST_RECEIPT_CORRUPT');
      const document = (await readRevisionDocument(
        this.database,
        source,
      )) as DraftRecord['document'];
      return {
        ...record,
        document,
        revision: { ...record.revision, document },
        publication: await this.publicationFor(record.id, record.revision.sequence),
      };
    }
    return {
      ...record,
      publication: await this.publicationFor(record.id, record.revision.sequence),
    };
  }

  private async publicationFor(draftId: string, sequence: number): Promise<DraftPublicationStatus> {
    const row = await this.database
      .prepare(
        `SELECT b.source_target AS publication_source_target,b.baseline_release_id,b.baseline_sequence,
      (SELECT id FROM current_publication_releases ORDER BY sequence DESC LIMIT 1) AS current_release_id
      FROM drafts d LEFT JOIN draft_publication_baselines b ON b.draft_id=d.id WHERE d.id=?`,
      )
      .bind(draftId)
      .first<Omit<DraftRow, 'id'>>();
    if (!row) throw new NotFoundError(`Draft ${draftId} was not found`);
    return publicationStatus({ ...row, sequence });
  }

  private idempotencyStatement(
    scope: string,
    key: string,
    actor: string,
    requestHash: string,
    statusCode: number,
    record: DraftRecord,
    now: string,
    revisionId?: string,
  ): D1PreparedStatement {
    const responseVersion = this.storageFormat === 'compact-v1' ? 2 : 1;
    const responseJson = JSON.stringify(
      responseVersion === 2
        ? { ...record, document: undefined, revision: { ...record.revision, document: undefined } }
        : record,
    );
    const expires = new Date(Date.parse(now) + 90 * 86_400_000).toISOString();
    return this.database
      .prepare(
        `INSERT INTO idempotency_keys (scope,idempotency_key,actor,request_hash,status_code,response_json,created_at,expires_at,request_version,response_version) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 2, ?${revisionId ? ' WHERE EXISTS (SELECT 1 FROM revisions WHERE id = ?)' : ''}`,
      )
      .bind(
        scope,
        key,
        actor,
        requestHash,
        statusCode,
        responseJson,
        now,
        expires,
        responseVersion,
        ...(revisionId ? [revisionId] : []),
      );
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
