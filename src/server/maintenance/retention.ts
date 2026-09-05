interface PrivateDeleteBucket {
  delete(key: string): Promise<void>;
}

interface RevisionRow extends Record<string, unknown> {
  id: string;
  draft_id: string;
}

interface DraftRow extends Record<string, unknown> {
  id: string;
}

interface MediaRow extends Record<string, unknown> {
  id: string;
  object_key: string;
  status: string;
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
    mediaToOrphan: MediaRow[];
    mediaToDelete: MediaRow[];
    auditEvents: AuditRow[];
  };
}

const DAY = 86_400_000;
const before = (now: Date, days: number) => new Date(now.getTime() - days * DAY).toISOString();

async function checksum(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

function referencedMedia(rows: Array<{ document_json: string }>): Set<string> {
  const result = new Set<string>();
  for (const row of rows) {
    try {
      const document = JSON.parse(row.document_json) as { media?: Array<{ id?: unknown }> };
      for (const item of document.media ?? []) if (typeof item.id === 'string') result.add(item.id);
    } catch {
      // Invalid stored documents are preserved; schema validation owns corruption reporting.
    }
  }
  return result;
}

export class RetentionService {
  constructor(
    private readonly database: D1Database,
    private readonly bucket: PrivateDeleteBucket,
  ) {}

  async plan(now = new Date()): Promise<RetentionPlan> {
    const automaticCutoff = before(now, 90);
    const draftCutoff = before(now, 30);
    const orphanCutoff = before(now, 7);
    const mediaDeleteCutoff = before(now, 30);
    const auditCutoff = before(now, 400);
    const [revisionRows, draftRows, latestRows, mediaRows, auditRows] = await Promise.all([
      this.database
        .prepare(
          "SELECT r.* FROM revisions r JOIN drafts d ON d.id=r.draft_id WHERE d.status!='deleted' AND r.created_at<? AND r.id!=d.latest_revision_id AND NOT EXISTS (SELECT 1 FROM revision_labels l WHERE l.revision_id=r.id) ORDER BY r.created_at,r.id",
        )
        .bind(automaticCutoff)
        .all<RevisionRow>(),
      this.database
        .prepare(
          "SELECT * FROM drafts WHERE status='deleted' AND deleted_at<? ORDER BY deleted_at,id",
        )
        .bind(draftCutoff)
        .all<DraftRow>(),
      this.database
        .prepare(
          "SELECT r.document_json FROM drafts d JOIN revisions r ON r.id=d.latest_revision_id WHERE d.status!='deleted'",
        )
        .all<{ document_json: string }>(),
      this.database.prepare('SELECT * FROM media_assets ORDER BY created_at,id').all<MediaRow>(),
      this.database
        .prepare('SELECT * FROM audit_events WHERE occurred_at<? ORDER BY occurred_at,id')
        .bind(auditCutoff)
        .all<AuditRow>(),
    ]);
    const draftIds = draftRows.results.map((row) => row.id);
    const deletedDraftRevisions = draftIds.length
      ? await this.database
          .prepare(
            `SELECT * FROM revisions WHERE draft_id IN (${draftIds.map(() => '?').join(',')}) ORDER BY draft_id,sequence`,
          )
          .bind(...draftIds)
          .all<RevisionRow>()
      : { results: [] as RevisionRow[] };
    const references = referencedMedia(latestRows.results);
    const mediaToOrphan = mediaRows.results.filter(
      (row) =>
        row.status === 'ready' && !references.has(row.id) && String(row.created_at) < orphanCutoff,
    );
    const mediaToDelete = mediaRows.results.filter(
      (row) =>
        row.status === 'orphaned' &&
        String(row.last_referenced_at ?? row.created_at) < mediaDeleteCutoff,
    );
    const exportData = {
      revisions: revisionRows.results,
      drafts: draftRows.results,
      deletedDraftRevisions: deletedDraftRevisions.results,
      mediaToOrphan,
      mediaToDelete,
      auditEvents: auditRows.results,
    };
    return {
      dryRun: true,
      generatedAt: now.toISOString(),
      exportChecksum: await checksum(exportData),
      report: {
        revisionsToDelete: revisionRows.results.length,
        draftsToDelete: draftRows.results.length,
        mediaToOrphan: mediaToOrphan.length,
        mediaToDelete: mediaToDelete.length,
        auditEventsToDelete: auditRows.results.length,
      },
      export: exportData,
    };
  }

  async apply(plan: RetentionPlan, savedExportChecksum: string, actor: string, requestId: string) {
    const observed = await checksum(plan.export);
    if (observed !== plan.exportChecksum || savedExportChecksum !== plan.exportChecksum)
      throw new Error('RETENTION_EXPORT_MISMATCH');

    for (const media of plan.export.mediaToDelete) await this.bucket.delete(media.object_key);
    const statements: D1PreparedStatement[] = [];
    const audit = (action: string, targetType: string, targetId: string) =>
      this.database
        .prepare(
          "INSERT INTO audit_events (id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json) VALUES (?,?,?,?,?,?,'succeeded',?,'{}')",
        )
        .bind(
          crypto.randomUUID(),
          new Date().toISOString(),
          actor,
          action,
          targetType,
          targetId,
          requestId,
        );

    for (const revision of plan.export.revisions) {
      statements.push(this.database.prepare('DELETE FROM revisions WHERE id=?').bind(revision.id));
      statements.push(audit('retention.revision.delete', 'revision', revision.id));
    }
    for (const draft of plan.export.drafts) {
      const revisions = plan.export.deletedDraftRevisions.filter(
        (row) => row.draft_id === draft.id,
      );
      for (const revision of revisions) {
        statements.push(
          this.database
            .prepare('DELETE FROM revision_labels WHERE revision_id=?')
            .bind(revision.id),
        );
        statements.push(
          this.database.prepare('DELETE FROM revisions WHERE id=?').bind(revision.id),
        );
        statements.push(audit('retention.revision.delete', 'revision', revision.id));
      }
      statements.push(this.database.prepare('DELETE FROM drafts WHERE id=?').bind(draft.id));
      statements.push(audit('retention.draft.delete', 'draft', draft.id));
    }
    for (const media of plan.export.mediaToOrphan) {
      statements.push(
        this.database
          .prepare("UPDATE media_assets SET status='orphaned' WHERE id=? AND status='ready'")
          .bind(media.id),
      );
      statements.push(audit('retention.media.orphan', 'media', media.id));
    }
    for (const media of plan.export.mediaToDelete) {
      statements.push(this.database.prepare('DELETE FROM media_assets WHERE id=?').bind(media.id));
      statements.push(audit('retention.media.delete', 'media', media.id));
    }
    for (const event of plan.export.auditEvents) {
      statements.push(this.database.prepare('DELETE FROM audit_events WHERE id=?').bind(event.id));
      statements.push(audit('retention.audit.delete', 'audit-event', event.id));
    }
    if (statements.length) await this.database.batch(statements);
    return { applied: true as const, exportChecksum: plan.exportChecksum, report: plan.report };
  }

  async applyCurrent(savedExportChecksum: string, actor: string, requestId: string) {
    return this.apply(await this.plan(), savedExportChecksum, actor, requestId);
  }
}
