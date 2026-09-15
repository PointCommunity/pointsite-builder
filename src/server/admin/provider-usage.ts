import { z } from 'zod';
import { publicationJson } from '../publish/build-proof';

const accountId = 'bc890091d86ddf9ce669e96e79d47746';
const databaseId = 'd4f44410-3f61-47bd-976a-5595973fa6f1';
const counter = z.number().int().nonnegative();
const rows = z.object({ rowsRead: counter, rowsWritten: counter });
const sampleSchema = z.object({
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
  account: rows,
  workspace: rows,
  workspaceStorageBytes: counter,
});
type UsageSample = z.infer<typeof sampleSchema>;
export type ProviderUsage =
  | { state: 'unknown'; reason: string; checkedAt?: string }
  | {
      state: 'reported' | 'stale';
      reason: string;
      checkedAt: string;
      collectedAt: string;
      sample: UsageSample;
    };

const query = `query BuilderUsage($accountTag: string, $accountFilter: ZoneWorkersRequestsFilter_InputObject, $workspaceFilter: ZoneWorkersRequestsFilter_InputObject) {
  viewer { accounts(filter: {accountTag: $accountTag}) {
    account: d1AnalyticsAdaptiveGroups(limit: 1, filter: $accountFilter) { sum { rowsRead rowsWritten } }
    workspace: d1AnalyticsAdaptiveGroups(limit: 1, filter: $workspaceFilter) { sum { rowsRead rowsWritten } }
  } }
}`;

/** A single database-clock claim bounds refreshes across requests and Worker instances. */
export async function refreshProviderUsage(
  database: D1Database,
  token?: string,
  fetcher: typeof fetch = fetch,
) {
  if (!token) return;
  const attemptId = crypto.randomUUID();
  const claim = await database
    .prepare(
      `UPDATE provider_usage
    SET attempt_id=?,checked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      refresh_after=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')
    WHERE id=1 AND refresh_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    RETURNING checked_at`,
    )
    .bind(attemptId)
    .first<{ checked_at: string }>();
  if (!claim) return;
  try {
    const periodEnd = claim.checked_at;
    const periodStart = `${periodEnd.slice(0, 10)}T00:00:00.000Z`;
    const read = async (url: string, body?: unknown) => {
      const response = await fetcher(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Provider unavailable');
      return publicationJson(response, 32_768);
    };
    const filter = { datetimeHour_geq: periodStart, datetimeHour_leq: periodEnd };
    const results = await Promise.all([
      read('https://api.cloudflare.com/client/v4/graphql', {
        query,
        variables: {
          accountTag: accountId,
          accountFilter: filter,
          workspaceFilter: { ...filter, databaseId },
        },
      }),
      read(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}?fields=uuid,file_size`,
      ),
    ]);
    const grouped = z.array(z.object({ sum: rows })).length(1);
    const analytics = z
      .object({
        errors: z.array(z.unknown()).length(0).nullish(),
        data: z.object({
          viewer: z.object({
            accounts: z.array(z.object({ account: grouped, workspace: grouped })).length(1),
          }),
        }),
      })
      .parse(results[0]).data.viewer.accounts[0];
    const storage = z
      .object({
        success: z.literal(true),
        result: z.object({ uuid: z.literal(databaseId), file_size: counter }),
      })
      .parse(results[1]).result;
    const sample = sampleSchema.parse({
      periodStart,
      periodEnd,
      account: analytics.account[0].sum,
      workspace: analytics.workspace[0].sum,
      workspaceStorageBytes: storage.file_size,
    });
    await database
      .prepare(
        `UPDATE provider_usage SET collected_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),data_json=?,last_error=NULL WHERE id=1 AND attempt_id=?`,
      )
      .bind(JSON.stringify(sample), attemptId)
      .run();
  } catch {
    // Only a fixed state is retained; provider bodies may contain operational details.
    await database
      .prepare("UPDATE provider_usage SET last_error='unavailable' WHERE id=1 AND attempt_id=?")
      .bind(attemptId)
      .run();
  }
}

/** Administrator reads never refresh provider data or write the cache. */
export async function readProviderUsage(database: D1Database): Promise<ProviderUsage> {
  const row = await database
    .prepare(
      `SELECT checked_at,collected_at,data_json,last_error,
    (collected_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')
      AND substr(json_extract(data_json,'$.periodStart'),1,10)=date('now')) AS fresh
    FROM provider_usage WHERE id=1`,
    )
    .first<{
      checked_at: string | null;
      collected_at: string | null;
      data_json: string | null;
      last_error: string | null;
      fresh: number;
    }>();
  if (!row?.checked_at || !row.collected_at || !row.data_json)
    return {
      state: 'unknown',
      reason: row?.checked_at
        ? 'Provider counters are unavailable.'
        : 'Read-only provider telemetry has not collected a sample.',
      ...(row?.checked_at ? { checkedAt: row.checked_at } : {}),
    };
  let value: unknown;
  try {
    value = JSON.parse(row.data_json) as unknown;
  } catch {
    value = null;
  }
  const sample = sampleSchema.safeParse(value);
  if (!sample.success)
    return {
      state: 'unknown',
      reason: 'Provider counters are unavailable.',
      checkedAt: row.checked_at,
    };
  return {
    state: row.fresh && !row.last_error ? 'reported' : 'stale',
    reason:
      'Provider analytics can arrive late. These counters do not verify the current plan or remaining account allowance.',
    checkedAt: row.checked_at,
    collectedAt: row.collected_at,
    sample: sample.data,
  };
}
