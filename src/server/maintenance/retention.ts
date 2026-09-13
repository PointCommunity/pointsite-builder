import { readRevisionDocument } from '../repositories/revision-payloads';
import type { D1DeletionReceipts } from './deletion-receipts';

interface RevisionRow extends Record<string, unknown> {
  id: string;
  draft_id: string;
  checksum: string;
  document_json: string;
}
interface DraftRow extends Record<string, unknown> {
  id: string;
}
interface AuditRow extends Record<string, unknown> {
  id: string;
}

export interface RetentionPlan {
  dryRun: true;
  generatedAt: string;
  exportChecksum: string;
  report: {
    revisionsToDelete: number;
    draftsToDelete: number;
    mediaToOrphan: number;
    mediaToDelete: number;
    auditEventsToDelete: number;
  };
  export: {
    revisions: RevisionRow[];
    drafts: DraftRow[];
    deletedDraftRevisions: RevisionRow[];
    mediaToOrphan: never[];
    mediaToDelete: never[];
    auditEvents: AuditRow[];
  };
}

// Includes compact payload/base reads and applyCurrent's dry run within the Free query limit.
const REVISION_BATCH = 6;
const AUDIT_BATCH = 4;
const clock = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const cutoff = (days: number) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${days} days')`;
const unreferencedCheckpoint = `NOT EXISTS (SELECT 1 FROM revision_payloads p WHERE p.base_revision_id=r.id)`;
const automaticEligible = `d.status='active' AND r.created_at<${cutoff(90)}
  AND r.id!=d.latest_revision_id AND r.label IS NULL
  AND NOT EXISTS (SELECT 1 FROM revision_labels l WHERE l.revision_id=r.id)
  AND ${unreferencedCheckpoint}
  AND NOT EXISTS (SELECT 1 FROM publish_preflights p WHERE p.draft_id=r.draft_id AND p.revision_id=r.id)
  AND NOT EXISTS (SELECT 1 FROM publish_jobs j WHERE json_extract(j.candidate_json,'$.revisionId')=r.id)
  AND NOT EXISTS (SELECT 1 FROM idempotency_keys k
    WHERE json_extract(k.response_json,'$.latestRevisionId')=r.id AND k.expires_at>${clock})`;
const noActivePublication = `NOT EXISTS (SELECT 1 FROM publish_jobs j WHERE json_extract(j.candidate_json,'$.draftId')=d.id AND j.status IN ('queued','running'))`;
const unpinnedRevision = 'NOT EXISTS (SELECT 1 FROM publication_inputs WHERE revision_id=r.id)';
const deletedEligible = `d.status='deleted' AND d.deleted_at<${cutoff(30)} AND ${unreferencedCheckpoint} AND ${unpinnedRevision} AND ${noActivePublication}`;

async function checksum(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}
const ids = (rows: Array<{ id: string }>) => JSON.stringify(rows.map((row) => row.id));
const report = (data: RetentionPlan['export']): RetentionPlan['report'] => ({
  revisionsToDelete: data.revisions.length,
  draftsToDelete: data.drafts.length,
  mediaToOrphan: 0,
  mediaToDelete: 0,
  auditEventsToDelete: data.auditEvents.length,
});

export class RetentionService {
  constructor(
    private readonly database: D1Database,
    private readonly deletionReceipts?: D1DeletionReceipts,
  ) {}

  private async requireMigration() {
    const state = await this.database
      .prepare('SELECT state FROM draft_asset_migration WHERE id=1')
      .first('state');
    if (state !== 'complete') throw new Error('ASSET_MIGRATION_INCOMPLETE');
    // Migration owns retired shared bytes; retention never races its recovery/export work.
    if (await this.database.prepare('SELECT 1 FROM media_assets LIMIT 1').first())
      throw new Error('ASSET_MIGRATION_INCOMPLETE');
  }

  async plan(): Promise<RetentionPlan> {
    await this.requireMigration();
    const revisions = await this.database
      .prepare(
        `SELECT r.* FROM revisions r INDEXED BY revisions_retention_age JOIN drafts d ON d.id=r.draft_id WHERE ${automaticEligible}
       ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
      )
      .bind(REVISION_BATCH)
      .all<RevisionRow>();
    const remaining = REVISION_BATCH - revisions.results.length;
    const deleted = remaining
      ? await this.database
          .prepare(
            `SELECT d.* FROM drafts d WHERE d.status='deleted' AND d.deleted_at<${cutoff(30)} AND ${noActivePublication}
            AND (NOT EXISTS (SELECT 1 FROM revisions r WHERE r.draft_id=d.id)
              OR EXISTS (SELECT 1 FROM revisions r WHERE r.draft_id=d.id AND ${unreferencedCheckpoint} AND ${unpinnedRevision}))
            ORDER BY d.deleted_at,d.id LIMIT 1`,
          )
          .first<DraftRow>()
      : null;
    const deletedRevisions = deleted
      ? (
          await this.database
            .prepare(
              `SELECT r.* FROM revisions r JOIN drafts d ON d.id=r.draft_id WHERE d.id=? AND ${deletedEligible}
       ORDER BY r.sequence DESC LIMIT ?`,
            )
            .bind(deleted.id, remaining)
            .all<RevisionRow>()
        ).results
      : [];
    const hasRemaining = deleted
      ? await this.database
          .prepare(
            'SELECT 1 FROM revisions WHERE draft_id=? AND id NOT IN (SELECT value FROM json_each(?)) LIMIT 1',
          )
          .bind(deleted.id, ids(deletedRevisions))
          .first()
      : null;
    const audit = await this.database
      .prepare(
        `SELECT * FROM audit_events WHERE occurred_at<${cutoff(400)} ORDER BY occurred_at,id LIMIT ?`,
      )
      .bind(AUDIT_BATCH)
      .all<AuditRow>();
    const exported = async (row: RevisionRow): Promise<RevisionRow> => ({
      ...row,
      document_json: JSON.stringify(await readRevisionDocument(this.database, row)),
    });
    const data: RetentionPlan['export'] = {
      revisions: await Promise.all(revisions.results.map(exported)),
      drafts: deleted && !hasRemaining ? [deleted] : [],
      deletedDraftRevisions: await Promise.all(deletedRevisions.map(exported)),
      mediaToOrphan: [],
      mediaToDelete: [],
      auditEvents: audit.results,
    };
    return {
      dryRun: true,
      generatedAt: new Date().toISOString(),
      exportChecksum: await checksum(data),
      report: report(data),
      export: data,
    };
  }

  async apply(plan: RetentionPlan, savedExportChecksum: string, actor: string, requestId: string) {
    await this.requireMigration();
    const data = plan.export;
    const allRevisions = [...data.revisions, ...data.deletedDraftRevisions];
    if (
      allRevisions.length > REVISION_BATCH ||
      data.drafts.length > 1 ||
      data.auditEvents.length > AUDIT_BATCH ||
      data.mediaToDelete.length ||
      data.mediaToOrphan.length ||
      new Set(allRevisions.map((row) => row.id)).size !== allRevisions.length ||
      (await checksum(data)) !== plan.exportChecksum ||
      savedExportChecksum !== plan.exportChecksum
    )
      throw new Error('RETENTION_EXPORT_MISMATCH');
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `SELECT json(CASE WHEN EXISTS (SELECT 1 FROM user_roles WHERE email=? COLLATE NOCASE AND role='administrator' AND active=1)
       AND (SELECT state FROM draft_asset_migration WHERE id=1)='complete'
       AND NOT EXISTS(SELECT 1 FROM media_assets)
       THEN 'true' ELSE 'retention-state-changed' END)`,
        )
        .bind(actor),
    ];
    const revisionGuard = (rows: RevisionRow[], eligible: string) =>
      this.database
        .prepare(
          `SELECT json(CASE WHEN (SELECT COUNT(*) FROM json_each(?) e JOIN revisions r ON r.id=json_extract(e.value,'$.id')
       JOIN drafts d ON d.id=r.draft_id WHERE r.draft_id=json_extract(e.value,'$.draft_id')
       AND r.checksum=json_extract(e.value,'$.checksum') AND ${eligible})=?
       THEN 'true' ELSE 'retention-state-changed' END)`,
        )
        .bind(
          JSON.stringify(rows.map(({ id, draft_id, checksum }) => ({ id, draft_id, checksum }))),
          rows.length,
        );
    statements.push(
      revisionGuard(data.revisions, automaticEligible),
      revisionGuard(data.deletedDraftRevisions, deletedEligible),
    );
    const audit = (action: string, targetType: string, targetId: string) =>
      this.database
        .prepare(
          `INSERT INTO audit_events (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json)
       VALUES (?,${clock},?,?,?,?,'succeeded',?,'{}')`,
        )
        .bind(crypto.randomUUID(), actor, action, targetType, targetId, requestId);
    const deletedDraftIds = [
      ...new Set([
        ...data.deletedDraftRevisions.map((row) => row.draft_id),
        ...data.drafts.map((row) => row.id),
      ]),
    ];
    const deletedIds = JSON.stringify(deletedDraftIds);
    statements.push(
      this.database
        .prepare(
          `SELECT json(CASE WHEN (SELECT COUNT(*) FROM json_each(?) e JOIN drafts d ON d.id=json_extract(e.value,'$.id')
       WHERE d.status='deleted' AND d.deleted_at<${cutoff(30)} AND d.deleted_at=json_extract(e.value,'$.deleted_at') AND ${noActivePublication}
       AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.draft_id=d.id AND r.id NOT IN (SELECT value FROM json_each(?))))=?
       THEN 'true' ELSE 'retention-state-changed' END)`,
        )
        .bind(JSON.stringify(data.drafts), ids(data.deletedDraftRevisions), data.drafts.length),
    );
    statements.push(
      this.database
        .prepare(
          `SELECT json(CASE WHEN (SELECT COUNT(*) FROM audit_events WHERE id IN (SELECT value FROM json_each(?))
       AND occurred_at<${cutoff(400)})=? THEN 'true' ELSE 'retention-state-changed' END)`,
        )
        .bind(ids(data.auditEvents), data.auditEvents.length),
    );
    if (deletedDraftIds.length) {
      statements.push(
        this.database
          .prepare(
            `UPDATE idempotency_keys SET status_code=410,response_json='{"deleted":true}',expires_at='9999-12-31T23:59:59.999Z'
         WHERE json_extract(response_json,'$.id') IN (SELECT value FROM json_each(?))`,
          )
          .bind(deletedIds),
      );
      statements.push(
        this.database
          .prepare(
            'UPDATE drafts SET latest_revision_id=NULL WHERE id IN (SELECT value FROM json_each(?))',
          )
          .bind(deletedIds),
      );
    }
    if (data.deletedDraftRevisions.length)
      statements.push(
        this.database
          .prepare(
            'DELETE FROM publish_preflights WHERE revision_id IN (SELECT value FROM json_each(?))',
          )
          .bind(ids(data.deletedDraftRevisions)),
      );
    if (allRevisions.length)
      statements.push(
        this.database
          .prepare('DELETE FROM revisions WHERE id IN (SELECT value FROM json_each(?))')
          .bind(ids(allRevisions)),
      );
    for (const row of allRevisions)
      statements.push(audit('retention.revision.delete', 'revision', row.id));
    if (data.drafts.length)
      statements.push(
        this.database
          .prepare('DELETE FROM drafts WHERE id IN (SELECT value FROM json_each(?))')
          .bind(ids(data.drafts)),
      );
    for (const row of data.drafts)
      statements.push(audit('retention.draft.delete', 'draft', row.id));
    if (data.auditEvents.length)
      statements.push(
        this.database
          .prepare('DELETE FROM audit_events WHERE id IN (SELECT value FROM json_each(?))')
          .bind(ids(data.auditEvents)),
      );
    for (const row of data.auditEvents)
      statements.push(audit('retention.audit.delete', 'audit-event', row.id));
    const deletions = this.deletionReceipts
      ? await Promise.all(
          deletedDraftIds.map((draftId) =>
            this.deletionReceipts!.prepare({ kind: 'draft', draftId }),
          ),
        )
      : [];
    statements.push(...deletions.map((receipt) => this.deletionReceipts!.proof(receipt)));
    try {
      await this.database.batch(statements);
    } catch (error) {
      if (error instanceof Error && error.message.includes('malformed JSON'))
        throw new Error('RETENTION_STATE_CHANGED');
      throw error;
    }
    for (const receipt of deletions)
      await this.deletionReceipts!.confirm(receipt).catch(() => {
        // Quarantined recovery settles a prepared receipt from its atomic workspace commit proof.
      });
    return { applied: true as const, exportChecksum: plan.exportChecksum, report: report(data) };
  }

  async applyCurrent(savedExportChecksum: string, actor: string, requestId: string) {
    return this.apply(await this.plan(), savedExportChecksum, actor, requestId);
  }
}
