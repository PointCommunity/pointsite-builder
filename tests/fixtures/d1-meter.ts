/** Counts executed native statements, including recovery guards and independent control work. */
export function meterDatabase(database: D1Database) {
  const totals = { queries: 0, rowsRead: 0, rowsWritten: 0 };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const collect = (result: D1Result) => {
    totals.queries++;
    totals.rowsRead += result.meta.rows_read;
    totals.rowsWritten += result.meta.rows_written;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === 'first')
          return async (column?: string) => {
            const result = await target.all<Record<string, unknown>>();
            collect(result);
            const row = result.results[0];
            if (row && column && !Object.hasOwn(row, column))
              throw new Error('Missing result column');
            return row ? (column ? row[column] : row) : null;
          };
        if (property === 'all' || property === 'run')
          return async () => {
            const result = await target[property]();
            collect(result);
            return result;
          };
        return Reflect.get(target, property) as unknown;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  return {
    totals,
    reset: () => Object.assign(totals, { queries: 0, rowsRead: 0, rowsWritten: 0 }),
    database: new Proxy(database, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(
              statements.map((item) => originals.get(item) ?? item),
            );
            results.forEach(collect);
            return results;
          };
        return Reflect.get(target, property) as unknown;
      },
    }),
  };
}
