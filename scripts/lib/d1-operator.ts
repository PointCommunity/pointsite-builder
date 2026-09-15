import { z } from 'zod';

/** Native HTTP batching accepts one SQL string. Encode values as SQLite literals, never raw input. */
export function bindOperatorSql(sql: string, values: unknown[]): string {
  let offset = 0;
  const bound = sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|\?\d*/g,
    (token) => {
      if (!token.startsWith('?')) return token;
      if (token !== '?' || offset >= values.length) throw new Error('RECOVERY_SQL_BINDING');
      const value = values[offset++];
      if (value === null) return 'NULL';
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'string')
        return `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
      if (value instanceof ArrayBuffer || value instanceof Uint8Array)
        return `X'${Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString('hex')}'`;
      throw new Error('RECOVERY_SQL_BINDING');
    },
  );
  if (offset !== values.length) throw new Error('RECOVERY_SQL_BINDING');
  return bound;
}

const resultSchema = z.array(
  z.object({
    success: z.literal(true),
    results: z.array(z.record(z.string(), z.unknown())),
    meta: z
      .object({
        rows_read: z.number(),
        rows_written: z.number(),
        changes: z.number(),
        duration: z.number(),
        size_after: z.number(),
        last_row_id: z.number(),
        changed_db: z.boolean(),
      })
      .passthrough(),
  }),
);

/** Reuse the tested recovery service over Cloudflare's native, atomic multi-statement HTTP API. */
export function operatorDatabase(query: (sql: string) => Promise<unknown>): D1Database {
  const statements = new WeakMap<D1PreparedStatement, string>();
  const unavailable = () => {
    throw new Error('RECOVERY_SQL_UNSUPPORTED');
  };
  const batch = async <T>(items: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const sql = items.map((item) => statements.get(item) ?? unavailable()).join(';\n');
    if (!items.length || Buffer.byteLength(sql) > 100_000) throw new Error('RECOVERY_SQL_BUDGET');
    const results = resultSchema.parse(await query(sql));
    if (results.length !== items.length) throw new Error('RECOVERY_SQL_RESULTS');
    return results as D1Result<T>[];
  };
  const prepare = (sql: string): D1PreparedStatement => {
    const statement: D1PreparedStatement = {
      bind: (...values: unknown[]) => prepare(bindOperatorSql(sql, values)),
      all: async <T>() => (await batch<T>([statement]))[0],
      run: async <T>() => (await batch<T>([statement]))[0],
      first: async <T>(column?: string) => {
        const row = (await batch<Record<string, unknown>>([statement]))[0].results[0];
        if (!row) return null;
        if (column === undefined) return row as T;
        if (!Object.hasOwn(row, column)) throw new Error('D1_COLUMN_NOTFOUND');
        return row[column] as T;
      },
      raw: unavailable,
    };
    statements.set(statement, sql);
    return statement;
  };
  return { prepare, batch, exec: unavailable, dump: unavailable, withSession: unavailable };
}
