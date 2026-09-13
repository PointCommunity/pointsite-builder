import { z } from 'zod';
import { checksumDocument } from '../../site-kit/canonicalize';
import { assertRecoveryDrained } from './recovery-control';
import { draftDeletionStatements } from './draft-deletion';
import { D1LibraryProjection } from '../media/library-projection';

export const DeletionTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('draft'), draftId: z.uuid() }),
  z.strictObject({
    kind: z.literal('library'),
    draftId: z.uuid(),
    itemId: z.uuid(),
    assetIds: z.array(z.uuid()).max(500),
  }),
]);
type Receipt = { id: string; hash: string };

/** No draft contents, paths, actor details, credentials or binary data leave the workspace. */
export class D1DeletionReceipts {
  constructor(
    private readonly workspace: D1Database,
    private readonly control: D1Database,
  ) {}

  async prepare(value: z.infer<typeof DeletionTargetSchema>): Promise<Receipt> {
    const target = DeletionTargetSchema.parse(value);
    const receipt = { id: crypto.randomUUID(), hash: await checksumDocument(target) };
    const created = await this.control
      .prepare(
        `INSERT INTO deletion_receipts(id,target_json,target_hash)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM workspace_recovery WHERE id=1 AND mode='active') RETURNING id`,
      )
      .bind(receipt.id, JSON.stringify(target), receipt.hash)
      .first();
    if (!created) throw new Error('DELETION_RECEIPT_UNAVAILABLE');
    return receipt;
  }

  proof(receipt: Receipt): D1PreparedStatement {
    return this.workspace
      .prepare('INSERT INTO deletion_commits(receipt_id,target_hash) VALUES (?,?)')
      .bind(receipt.id, receipt.hash);
  }

  async confirm(receipt: Receipt): Promise<void> {
    const proof = await this.workspace
      .prepare('SELECT 1 FROM deletion_commits WHERE receipt_id=? AND target_hash=?')
      .bind(receipt.id, receipt.hash)
      .first();
    if (!proof) throw new Error('DELETION_COMMIT_UNCONFIRMED');
    const updated = await this.control
      .prepare(
        `UPDATE deletion_receipts SET state='committed',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND target_hash=? AND state='pending' RETURNING id`,
      )
      .bind(receipt.id, receipt.hash)
      .first();
    if (
      !updated &&
      !(await this.control
        .prepare(
          "SELECT 1 FROM deletion_receipts WHERE id=? AND target_hash=? AND state='committed'",
        )
        .bind(receipt.id, receipt.hash)
        .first())
    )
      throw new Error('DELETION_COMMIT_UNCONFIRMED');
  }

  /** Run only after quarantine drains all leases, before restoration can erase commit proofs. */
  async settlePending(epoch: number, recoveryId: string) {
    await assertRecoveryDrained(this.workspace, this.control, epoch, recoveryId);
    const rows = (
      await this.control
        .prepare(
          "SELECT id,target_hash FROM deletion_receipts WHERE state='pending' ORDER BY prepared_at,id LIMIT 20",
        )
        .all<{ id: string; target_hash: string }>()
    ).results;
    if (!rows.length) return { settled: 0 };
    const committed = (
      await this.workspace
        .prepare(
          `SELECT receipt_id,target_hash FROM deletion_commits
      WHERE receipt_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(JSON.stringify(rows.map((row) => row.id)))
        .all<{ receipt_id: string; target_hash: string }>()
    ).results;
    const proofs = new Map(committed.map((row) => [row.receipt_id, row.target_hash]));
    if (rows.some((row) => proofs.has(row.id) && proofs.get(row.id) !== row.target_hash))
      throw new Error('DELETION_COMMIT_UNCONFIRMED');
    await this.control.batch([
      this.control
        .prepare(
          `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM workspace_recovery
        WHERE id=1 AND mode='quarantined' AND epoch=? AND recovery_id=?) THEN 'true' ELSE 'recovery-changed' END)`,
        )
        .bind(epoch, recoveryId),
      ...rows.map((row) =>
        this.control
          .prepare(
            `UPDATE deletion_receipts SET state=?,resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND target_hash=? AND state='pending'`,
          )
          .bind(proofs.has(row.id) ? 'committed' : 'cancelled', row.id, row.target_hash),
      ),
    ]);
    return { settled: rows.length };
  }

  /** One confirmed receipt per transaction, against a quarantined restored workspace. */
  async replay(epoch: number, recoveryId: string, receiptId: string) {
    z.uuid().parse(receiptId);
    await assertRecoveryDrained(this.workspace, this.control, epoch, recoveryId);
    const row = await this.control
      .prepare(
        "SELECT target_json,target_hash FROM deletion_receipts WHERE id=? AND state='committed'",
      )
      .bind(receiptId)
      .first<{ target_json: string; target_hash: string }>();
    if (!row) throw new Error('DELETION_COMMIT_UNCONFIRMED');
    const target = DeletionTargetSchema.parse(JSON.parse(row.target_json));
    if ((await checksumDocument(target)) !== row.target_hash)
      throw new Error('DELETION_COMMIT_UNCONFIRMED');
    const replayed = await this.workspace
      .prepare('SELECT target_hash FROM deletion_replays WHERE recovery_id=? AND receipt_id=?')
      .bind(recoveryId, receiptId)
      .first<string>('target_hash');
    if (replayed) {
      if (replayed !== row.target_hash) throw new Error('DELETION_COMMIT_UNCONFIRMED');
      return { replayed: true as const };
    }
    const statements: D1PreparedStatement[] = [];
    if (target.kind === 'draft') {
      statements.push(
        this.workspace
          .prepare(
            `SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM publication_inputs WHERE draft_id=?)
          AND NOT EXISTS(SELECT 1 FROM publish_jobs WHERE json_extract(candidate_json,'$.draftId')=? AND status IN ('queued','running'))
          THEN 'true' ELSE 'deletion-replay-publication-retained' END)`,
          )
          .bind(target.draftId, target.draftId),
        this.workspace
          .prepare(
            "UPDATE drafts SET latest_revision_id=NULL,status='deleted',deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
          )
          .bind(target.draftId),
        ...draftDeletionStatements(this.workspace, target.draftId),
      );
    } else {
      const draft = await this.workspace
        .prepare(
          `SELECT r.sequence FROM drafts d JOIN revisions r ON r.id=d.latest_revision_id WHERE d.id=?`,
        )
        .bind(target.draftId)
        .first<{ sequence: number }>();
      if (draft) {
        const generation = await new D1LibraryProjection(this.workspace).requireCoverage(
          target.draftId,
          draft.sequence,
        );
        // A bookmark restoring referenced history needs a later safe bookmark; never silently return that content.
        statements.push(
          this.workspace
            .prepare(
              `SELECT json(CASE WHEN
          EXISTS(SELECT 1 FROM draft_library_projection WHERE draft_id=? AND sequence=? AND generation=?)
          AND NOT EXISTS(SELECT 1 FROM draft_library_history WHERE draft_id=? AND item_id=?)
          AND NOT EXISTS(SELECT 1 FROM draft_library_retained_paths p JOIN draft_asset_bindings b
            ON b.draft_id=p.draft_id AND b.source_path=p.source_path WHERE p.draft_id=?
            AND b.asset_id IN (SELECT value FROM json_each(?)))
          THEN 'true' ELSE 'deletion-replay-referenced' END)`,
            )
            .bind(
              target.draftId,
              draft.sequence,
              generation,
              target.draftId,
              target.itemId,
              target.draftId,
              JSON.stringify(target.assetIds),
            ),
        );
      } else if (
        await this.workspace.prepare('SELECT 1 FROM drafts WHERE id=?').bind(target.draftId).first()
      )
        throw new Error('DELETION_REPLAY_REFERENCED');
      statements.push(
        this.workspace
          .prepare('DELETE FROM draft_library_items WHERE draft_id=? AND item_id=?')
          .bind(target.draftId, target.itemId),
        this.workspace
          .prepare(
            'DELETE FROM draft_asset_versions WHERE draft_id=? AND id IN (SELECT value FROM json_each(?))',
          )
          .bind(target.draftId, JSON.stringify(target.assetIds)),
      );
    }
    statements.push(
      this.workspace
        .prepare('INSERT INTO deletion_replays(recovery_id,receipt_id,target_hash) VALUES (?,?,?)')
        .bind(recoveryId, receiptId, row.target_hash),
    );
    await this.workspace.batch(statements);
    return { replayed: true as const };
  }
}
