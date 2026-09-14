/* eslint-disable @typescript-eslint/require-await -- Preserve the existing asynchronous SQL contract and rejected errors over synchronous native transactions. */
import { DatabaseSync, backup, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { closeSync, constants, openSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';

/** Local implementation of the SQL contract consumed by the existing repositories. */
export class SqliteDatabase implements D1Database {
  private readonly native: DatabaseSync;
  private readonly statements = new WeakMap<D1PreparedStatement, () => D1Result>();
  private closed = false;

  constructor(private readonly path: string) {
    if (path !== ':memory:') {
      const descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      closeSync(descriptor);
    }
    this.native = new DatabaseSync(path, { timeout: 5_000 });
    try {
      this.native.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    } catch (error) {
      this.native.close();
      throw error;
    }
  }

  prepare(query: string): D1PreparedStatement {
    const native = this.native.prepare(query);
    if (query.slice(native.sourceSQL.length).trim()) throw new Error('SQL_MULTIPLE_STATEMENTS');
    native.setAllowBareNamedParameters(false);
    return this.bind(native, []);
  }

  private bind(native: StatementSync, values: SQLInputValue[]): D1PreparedStatement {
    const execute = () => this.execute(native, values);
    const statement: D1PreparedStatement = {
      bind: (...input: unknown[]) => this.bind(native, input.map(sqlValue)),
      all: async <T>() => execute() as D1Result<T>,
      run: async <T>() => execute() as D1Result<T>,
      first: async <T>(column?: string): Promise<T | null> => {
        const row = execute().results[0] as Record<string, unknown> | undefined;
        if (!row) return null;
        if (column === undefined) return row as T;
        if (!Object.hasOwn(row, column)) throw new Error('SQL_COLUMN_NOT_FOUND');
        return row[column] as T;
      },
      raw: async () => {
        throw new Error('SQL_RAW_NOT_SUPPORTED');
      },
    };
    this.statements.set(statement, execute);
    return statement;
  }

  private execute(statement: StatementSync, values: SQLInputValue[]): D1Result {
    const started = performance.now();
    const before = this.native.prepare('SELECT total_changes() AS count').get()!.count;
    const results = statement
      .all(...values)
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            // D1 returns BLOBs as byte arrays; existing repositories rely on that contract.
            value instanceof Uint8Array ? Array.from(value) : value,
          ]),
        ),
      );
    const state = this.native
      .prepare(
        'SELECT total_changes() AS total, changes() AS changes, last_insert_rowid() AS last_id',
      )
      .get()!;
    const changed = state.total !== before;
    return {
      success: true,
      results,
      meta: {
        duration: performance.now() - started,
        size_after:
          Number(this.native.prepare('PRAGMA page_count').get()!.page_count) *
          Number(this.native.prepare('PRAGMA page_size').get()!.page_size),
        // Native SQLite does not expose D1 billing counters. NaN means unavailable, never zero usage.
        rows_read: Number.NaN,
        rows_written: Number.NaN,
        last_row_id: Number(state.last_id),
        changed_db: changed,
        changes: changed ? Number(state.changes) : 0,
      },
    };
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const operations = statements.map((statement) => {
      const execute = this.statements.get(statement);
      if (!execute) throw new Error('SQL_FOREIGN_STATEMENT');
      return execute;
    });
    if (operations.length === 0) return [];
    // ponytail: one local writer; use a server database if multiple replicas become necessary.
    this.native.exec('BEGIN IMMEDIATE');
    try {
      const results = operations.map((execute) => execute() as D1Result<T>);
      this.native.exec('COMMIT');
      return results;
    } catch (error) {
      try {
        this.native.exec('ROLLBACK');
      } catch {
        /* A RAISE(ROLLBACK) trigger may already have rolled back. */
      }
      throw error;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    const started = performance.now();
    this.native.exec(query);
    return { count: 1, duration: performance.now() - started };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('USE_CONSISTENT_SQLITE_BACKUP');
  }
  withSession(): D1DatabaseSession {
    throw new Error('SQL_REMOTE_SESSION_NOT_SUPPORTED');
  }

  async backupTo(destination: string): Promise<void> {
    // backup() overwrites by default. Claim a new private file before invoking it.
    const file = await open(destination, 'wx', 0o600);
    await file.close();
    try {
      await backup(this.native, destination, { rate: 100 });
      const check = new DatabaseSync(destination);
      try {
        // Make the closed backup self-contained: no unmanifested WAL or shared-memory sidecar.
        if (check.prepare('PRAGMA journal_mode=DELETE').get()!.journal_mode !== 'delete')
          throw new Error('BACKUP_JOURNAL_NOT_CLOSED');
        if (
          check.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
          check.prepare('PRAGMA foreign_key_check').all().length
        )
          throw new Error('BACKUP_INTEGRITY_FAILED');
      } finally {
        check.close();
      }
      const written = await open(destination, 'r');
      try {
        await written.sync();
      } finally {
        await written.close();
      }
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
  }

  /** Operator recovery only, after all workspace invocation leases have drained. */
  async replaceFrom(source: SqliteDatabase): Promise<void> {
    if (this.path === ':memory:' || source === this) throw new Error('RESTORE_TARGET_INVALID');
    // SQLite owns the destination transaction and WAL locks; never replace an active main file with fs.copyFile.
    await backup(source.native, this.path, { rate: 100 });
  }

  close(): void {
    if (this.closed) return;
    this.native.close();
    this.closed = true;
  }
}

function sqlValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new Error('SQL_BINDING_TYPE_UNSUPPORTED');
}
