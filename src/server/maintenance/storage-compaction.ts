import { canonicalize, checksumDocument } from '../../site-kit/canonicalize';
import type { DraftRecord } from '../repositories/contracts';
import {
  prepareRevisionPayload,
  readRevisionDocument,
  type StoredRevisionDocument,
} from '../repositories/revision-payloads';

const legacyReceipts =
  "response_version=1 AND status_code IN (200,201) AND json_type(response_json,'$.document')='object'";

/** Each step is atomic and independently restartable. The caller verifies the deployed reader first. */
export class D1StorageCompaction {
  constructor(private readonly database: D1Database) {}

  async status() {
    const counts = await this.database
      .prepare(
        `SELECT (SELECT COUNT(*) FROM revisions WHERE document_json!='{}') AS revisions,
      (SELECT COUNT(*) FROM idempotency_keys WHERE ${legacyReceipts}) AS receipts`,
      )
      .first<{ revisions: number; receipts: number }>();
    if (!counts) throw new Error('STORAGE_COMPACTION_UNAVAILABLE');
    return {
      state: counts.revisions || counts.receipts ? ('pending' as const) : ('complete' as const),
      ...counts,
    };
  }

  async step(actor: string, requestId: string) {
    if (
      (await this.database
        .prepare('SELECT state FROM draft_asset_migration WHERE id=1')
        .first('state')) !== 'complete'
    )
      throw new Error('ASSET_MIGRATION_INCOMPLETE');
    const revision = await this.database
      .prepare(
        "SELECT id,draft_id,sequence,checksum,document_json FROM revisions WHERE document_json!='{}' ORDER BY draft_id,sequence LIMIT 1",
      )
      .first<StoredRevisionDocument & { sequence: number }>();
    if (revision) {
      const document: unknown = JSON.parse(revision.document_json);
      if ((await checksumDocument(document)) !== revision.checksum)
        throw new Error('REVISION_CHECKSUM_MISMATCH');
      const payload = await prepareRevisionPayload(this.database, {
        id: revision.id,
        draftId: revision.draft_id,
        sequence: revision.sequence,
        document,
      });
      await this.database.batch([
        this.database
          .prepare(
            `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM revisions WHERE id=? AND document_json=? AND checksum=?) THEN 'true' ELSE 'compaction-source-changed' END)`,
          )
          .bind(revision.id, revision.document_json, revision.checksum),
        ...payload.statements,
        this.database
          .prepare("UPDATE revisions SET document_json='{}' WHERE id=?")
          .bind(revision.id),
        this.audit(actor, requestId, 'revision.storage.compact', 'revision', revision.id),
      ]);
      return { processed: 'revision' as const };
    }
    const receipt = await this.database
      .prepare(
        `SELECT scope,actor,idempotency_key,response_json,expires_at,expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AS expired FROM idempotency_keys WHERE ${legacyReceipts} ORDER BY created_at,scope,actor,idempotency_key LIMIT 1`,
      )
      .first<{
        scope: string;
        actor: string;
        idempotency_key: string;
        response_json: string;
        expires_at: string;
        expired: number;
      }>();
    if (!receipt) return { processed: null };
    const expired = receipt.expired === 1;
    const record = JSON.parse(receipt.response_json) as DraftRecord;
    if (!expired) {
      const source = await this.database
        .prepare(
          'SELECT id,draft_id,checksum,document_json FROM revisions WHERE id=? AND draft_id=?',
        )
        .bind(record.latestRevisionId, record.id)
        .first<StoredRevisionDocument>();
      if (
        !source ||
        source.id !== record.revision.id ||
        source.checksum !== record.revision.checksum
      )
        throw new Error('RECEIPT_REVISION_MISMATCH');
      const document = canonicalize(await readRevisionDocument(this.database, source));
      if (
        canonicalize(record.document) !== document ||
        canonicalize(record.revision.document) !== document
      )
        throw new Error('RECEIPT_DOCUMENT_MISMATCH');
    }
    const response = expired
      ? { expired: true }
      : { ...record, document: undefined, revision: { ...record.revision, document: undefined } };
    await this.database.batch([
      this.database
        .prepare(
          `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM idempotency_keys WHERE scope=? AND actor=? AND idempotency_key=? AND response_version=1 AND response_json=? AND expires_at=? AND (?=0 OR expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))) THEN 'true' ELSE 'compaction-receipt-changed' END)`,
        )
        .bind(
          receipt.scope,
          receipt.actor,
          receipt.idempotency_key,
          receipt.response_json,
          receipt.expires_at,
          expired ? 1 : 0,
        ),
      this.database
        .prepare(
          'UPDATE idempotency_keys SET response_json=?,response_version=? WHERE scope=? AND actor=? AND idempotency_key=?',
        )
        .bind(
          JSON.stringify(response),
          expired ? 1 : 2,
          receipt.scope,
          receipt.actor,
          receipt.idempotency_key,
        ),
      this.audit(actor, requestId, 'receipt.storage.compact', 'draft', record.id),
    ]);
    return { processed: 'receipt' as const };
  }

  private audit(
    actor: string,
    requestId: string,
    action: string,
    targetType: string,
    targetId: string,
  ) {
    return this.database
      .prepare(
        "INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json) VALUES (?,?,?,?,?,?,'succeeded',?,'{}')",
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
  }
}
