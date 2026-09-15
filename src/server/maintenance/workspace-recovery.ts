import { z } from 'zod';
import { checksumDocument } from '../../site-kit/canonicalize';
import { assertRecoveryDrained } from './recovery-control';
import { D1DeletionReceipts } from './deletion-receipts';

export const RecoveryBookmarkSchema = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{32}$/);
type RecoveryRun = {
  protected_hash: string;
  target_bookmark: string;
  previous_bookmark: string;
  phase: 'prepared' | 'restoring' | 'restored' | 'complete';
  receipt_cursor: string;
};

/** Scoped infrastructure operator only. No browser session or public API can bypass quarantine. */
export class D1WorkspaceRecovery {
  constructor(
    private readonly workspace: D1Database,
    private readonly control: D1Database,
  ) {}

  private async run(epoch: number, id: string): Promise<RecoveryRun> {
    await assertRecoveryDrained(this.workspace, this.control, epoch, id);
    const run = await this.control
      .prepare('SELECT * FROM workspace_recovery_runs WHERE id=? AND epoch=?')
      .bind(id, epoch)
      .first<RecoveryRun>();
    if (!run) throw new Error('WORKSPACE_RECOVERY_PHASE');
    return run;
  }

  private guard(epoch: number, id: string) {
    return this.control
      .prepare(
        `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM workspace_recovery
      WHERE id=1 AND mode='quarantined' AND epoch=? AND recovery_id=?) THEN 'true' ELSE 'recovery-changed' END)`,
      )
      .bind(epoch, id);
  }

  /** Shared by native recovery; role, publication and schema authority must never move backwards. */
  async protectedHash() {
    const schema = (
      await this.workspace
        .prepare(
          `SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
        )
        .all<{ type: string; name: string }>()
    ).results;
    let hash = await checksumDocument(schema);
    for (const table of schema.filter(
      (row) =>
        row.type === 'table' &&
        (['user_roles', 'approvals', 'publish_jobs', 'draft_asset_migration'].includes(row.name) ||
          row.name.startsWith('publication_')),
    )) {
      if (!/^[a-z][a-z0-9_]*$/.test(table.name)) throw new Error('WORKSPACE_RECOVERY_SCHEMA');
      let after = 0;
      // Bounded pages; only the final digest is persisted outside the workspace.
      for (;;) {
        const rows = (
          await this.workspace
            .prepare(
              `SELECT rowid AS recovery_rowid,* FROM ${table.name}
          WHERE rowid>? ORDER BY rowid LIMIT 100`,
            )
            .bind(after)
            .all<{ recovery_rowid: number }>()
        ).results;
        if (!rows.length) break;
        hash = await checksumDocument({ hash, table: table.name, rows });
        after = rows.at(-1)!.recovery_rowid;
      }
    }
    return hash;
  }

  async prepare(epoch: number, id: string, target: string, previous: string) {
    RecoveryBookmarkSchema.parse(target);
    RecoveryBookmarkSchema.parse(previous);
    if (target >= previous) throw new Error('WORKSPACE_RECOVERY_BOOKMARK');
    await assertRecoveryDrained(this.workspace, this.control, epoch, id);
    const existing = await this.control
      .prepare('SELECT * FROM workspace_recovery_runs WHERE id=? AND epoch=?')
      .bind(id, epoch)
      .first<RecoveryRun>();
    if (existing) {
      if (existing.target_bookmark !== target || existing.previous_bookmark !== previous)
        throw new Error('WORKSPACE_RECOVERY_CHANGED');
      return;
    }
    if (
      await this.control
        .prepare("SELECT 1 FROM deletion_receipts WHERE state='pending' LIMIT 1")
        .first()
    )
      throw new Error('WORKSPACE_RECOVERY_PENDING_DELETION');
    const busy = await this.workspace
      .prepare(
        `SELECT 1 FROM publish_jobs WHERE status IN ('queued','running')
      UNION ALL SELECT 1 FROM publication_verifications WHERE status IN ('queued','running')
      UNION ALL SELECT 1 FROM publication_rollbacks WHERE status IN ('queued','running')
      UNION ALL SELECT 1 FROM publication_slots s JOIN publish_jobs j ON j.id=s.job_id WHERE j.status!='succeeded' LIMIT 1`,
      )
      .first();
    if (busy) throw new Error('WORKSPACE_RECOVERY_PUBLICATION_ACTIVE');
    if (
      !(await this.workspace
        .prepare("SELECT 1 FROM draft_asset_migration WHERE id=1 AND state='complete'")
        .first())
    )
      throw new Error('WORKSPACE_RECOVERY_MIGRATION_INCOMPLETE');
    const hash = await this.protectedHash();
    await this.control.batch([
      this.guard(epoch, id),
      this.control
        .prepare(
          `INSERT INTO workspace_recovery_runs
      (id,epoch,protected_hash,target_bookmark,previous_bookmark) VALUES (?,?,?,?,?)`,
        )
        .bind(id, epoch, hash, target, previous),
    ]);
  }

  /** At most one native restore call. An uncertain response leaves access closed for operator reconciliation. */
  async restore(
    epoch: number,
    id: string,
    nativeRestore: (bookmark: string) => Promise<{ bookmark: string; previous_bookmark: string }>,
  ) {
    const run = await this.run(epoch, id);
    if (run.phase !== 'prepared') throw new Error('WORKSPACE_RECOVERY_PHASE');
    const claimed = await this.control
      .prepare(
        `UPDATE workspace_recovery_runs SET phase='restoring'
      WHERE id=? AND epoch=? AND phase='prepared' RETURNING id`,
      )
      .bind(id, epoch)
      .first();
    if (!claimed) throw new Error('WORKSPACE_RECOVERY_PHASE');
    const result = await nativeRestore(run.target_bookmark);
    if (
      result.bookmark !== run.target_bookmark ||
      !RecoveryBookmarkSchema.safeParse(result.previous_bookmark).success
    )
      throw new Error('WORKSPACE_RECOVERY_RESTORE_UNCERTAIN');
    await this.control.batch([
      this.guard(epoch, id),
      this.control
        .prepare(
          `UPDATE workspace_recovery_runs SET phase='restored',restored_previous_bookmark=?
      WHERE id=? AND epoch=? AND phase='restoring'`,
        )
        .bind(result.previous_bookmark, id, epoch),
    ]);
  }

  async replayNext(epoch: number, id: string) {
    const run = await this.run(epoch, id);
    if (run.phase !== 'restored') throw new Error('WORKSPACE_RECOVERY_PHASE');
    const next = await this.control
      .prepare(
        `SELECT id FROM deletion_receipts
      WHERE state='committed' AND id>? ORDER BY id LIMIT 1`,
      )
      .bind(run.receipt_cursor)
      .first<string>('id');
    if (!next) return { replayed: 0 };
    await new D1DeletionReceipts(this.workspace, this.control).replay(epoch, id, next);
    await this.control.batch([
      this.guard(epoch, id),
      this.control
        .prepare(
          `UPDATE workspace_recovery_runs SET receipt_cursor=?
      WHERE id=? AND epoch=? AND phase='restored' AND receipt_cursor=?`,
        )
        .bind(next, id, epoch, run.receipt_cursor),
    ]);
    return { replayed: 1 };
  }

  async reopen(epoch: number, id: string) {
    z.number().int().positive().parse(epoch);
    z.uuid().parse(id);
    const completed = await this.control
      .prepare(
        `SELECT 1 FROM workspace_recovery_runs r,workspace_recovery s
      WHERE r.id=? AND r.epoch=? AND r.phase='complete' AND s.id=1 AND s.mode='active' AND s.epoch=?`,
      )
      .bind(id, epoch, epoch + 1)
      .first();
    if (completed) return;
    const run = await this.run(epoch, id);
    if (run.phase !== 'restored') throw new Error('WORKSPACE_RECOVERY_PHASE');
    if (
      await this.control
        .prepare(
          `SELECT 1 FROM deletion_receipts
      WHERE state='pending' OR (state='committed' AND id>?) LIMIT 1`,
        )
        .bind(run.receipt_cursor)
        .first()
    )
      throw new Error('WORKSPACE_RECOVERY_PENDING_DELETION');
    if ((await this.protectedHash()) !== run.protected_hash)
      throw new Error('WORKSPACE_RECOVERY_PROTECTED_STATE');
    const integrity = await this.workspace
      .prepare('PRAGMA quick_check')
      .first<Record<string, unknown>>();
    const foreignKeys = await this.workspace.prepare('PRAGMA foreign_key_check').all();
    if (!integrity || Object.values(integrity)[0] !== 'ok' || foreignKeys.results.length)
      throw new Error('WORKSPACE_RECOVERY_INTEGRITY');
    await this.workspace.batch([
      this.workspace.prepare('DELETE FROM draft_checkouts'),
      this.workspace.prepare('DELETE FROM publish_preflights'),
    ]);
    await this.control.batch([
      this.guard(epoch, id),
      this.control
        .prepare(
          `UPDATE workspace_recovery_runs SET phase='complete',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND epoch=? AND phase='restored'`,
        )
        .bind(id, epoch),
      this.control
        .prepare(
          `UPDATE workspace_recovery SET mode='active',recovery_id=NULL,epoch=epoch+1
        WHERE id=1 AND mode='quarantined' AND epoch=? AND recovery_id=?`,
        )
        .bind(epoch, id),
    ]);
  }
}
