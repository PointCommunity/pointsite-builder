import { z } from 'zod';

const clock = "CAST(strftime('%s','now') AS INTEGER)";
const unavailable = () => {
  throw new Error('WORKSPACE_ACCESS_UNAVAILABLE');
};

/** One nonrenewable invocation lease. Only the operator retains the raw database during recovery. */
export async function openRecoveryDatabase(
  workspace: D1Database,
  control: D1Database | undefined,
  leaseSeconds = 60,
): Promise<D1Database> {
  let epoch: number;
  try {
    if (!control || !Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 60)
      return unavailable();
    const state = await control
      .prepare("SELECT epoch FROM workspace_recovery WHERE id=1 AND mode='active'")
      .first<{ epoch: number }>();
    if (!state) return unavailable();
    epoch = state.epoch;
  } catch {
    return unavailable();
  }
  // Invalid sessions never reach workspace queries and therefore consume no control-store writes.
  let issued: Promise<number> | undefined;
  const issueLease = async () => {
    try {
      const now = await workspace.prepare(`SELECT ${clock} AS now`).first<number>('now');
      if (!Number.isSafeInteger(now) || !now) return unavailable();
      const deadline = now + leaseSeconds;
      const lease = await control
        .prepare(
          `UPDATE workspace_recovery SET leased_until=MAX(leased_until,?)
      WHERE id=1 AND mode='active' AND epoch=? RETURNING epoch`,
        )
        .bind(deadline, epoch)
        .first();
      if (!lease) return unavailable();
      return deadline;
    } catch {
      return unavailable();
    }
  };

  const statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const batch = async <T = unknown>(items: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const raw = items.map((item) => statements.get(item) ?? unavailable());
    const deadline = await (issued ??= issueLease());
    try {
      const result = await workspace.batch<T>([
        workspace
          .prepare(
            `SELECT json(CASE WHEN ${clock}<? THEN 'true' ELSE 'workspace-access-expired' END)`,
          )
          .bind(deadline),
        ...raw,
      ]);
      return result.slice(1);
    } catch (error) {
      // Preserve application transaction errors; only an expired native-clock lease changes the error.
      const now = await workspace
        .prepare(`SELECT ${clock} AS now`)
        .first<number>('now')
        .catch(() => null);
      if (now !== null && now >= deadline) return unavailable();
      throw error;
    }
  };
  const prepare = (raw: D1PreparedStatement): D1PreparedStatement => {
    const statement: D1PreparedStatement = {
      bind: (...values: unknown[]) => prepare(raw.bind(...values)),
      all: async <T>() => (await batch<T>([statement]))[0],
      run: async <T>() => (await batch<T>([statement]))[0],
      first: async <T>(column?: string): Promise<T | null> => {
        const row = (await batch<Record<string, unknown>>([statement]))[0].results[0];
        if (!row) return null;
        if (column === undefined) return row as T;
        if (!Object.hasOwn(row, column)) throw new Error('D1_COLUMN_NOTFOUND');
        return row[column] as T;
      },
      raw: unavailable,
    };
    statements.set(statement, raw);
    return statement;
  };
  return {
    prepare: (query: string) => prepare(workspace.prepare(query)),
    batch,
    exec: unavailable,
    dump: unavailable,
    withSession: unavailable,
  };
}

/** Called through scoped operator access; repeated requests retain the same quarantine boundary. */
export async function quarantineWorkspace(control: D1Database, epoch: number, recoveryId: string) {
  z.number().int().positive().parse(epoch);
  z.uuid().parse(recoveryId);
  const fields = 'epoch,mode,leased_until,recovery_id';
  const changed = await control
    .prepare(
      `UPDATE workspace_recovery
    SET mode='quarantined',epoch=epoch+1,recovery_id=?
    WHERE id=1 AND mode='active' AND epoch=? RETURNING ${fields}`,
    )
    .bind(recoveryId, epoch)
    .first();
  const current =
    changed ??
    (await control
      .prepare(
        `SELECT ${fields} FROM workspace_recovery
    WHERE id=1 AND mode='quarantined' AND epoch=? AND recovery_id=?`,
      )
      .bind(epoch + 1, recoveryId)
      .first());
  if (!current) throw new Error('WORKSPACE_RECOVERY_CHANGED');
  return current;
}

/** Native clock, not deployment timing or a local sleep, proves that old invocations are fenced. */
export async function assertRecoveryDrained(
  workspace: D1Database,
  control: D1Database,
  epoch: number,
  recoveryId: string,
): Promise<void> {
  z.number().int().positive().parse(epoch);
  z.uuid().parse(recoveryId);
  const state = await control
    .prepare(
      `SELECT leased_until FROM workspace_recovery
    WHERE id=1 AND mode='quarantined' AND epoch=? AND recovery_id=?`,
    )
    .bind(epoch, recoveryId)
    .first<{ leased_until: number }>();
  if (!state) throw new Error('WORKSPACE_RECOVERY_CHANGED');
  const now = await workspace.prepare(`SELECT ${clock} AS now`).first<number>('now');
  if (now === null || now < state.leased_until) throw new Error('WORKSPACE_RECOVERY_DRAINING');
}
