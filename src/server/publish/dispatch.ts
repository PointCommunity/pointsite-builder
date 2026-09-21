import { z } from 'zod';
import { createPublisherToken, githubHeaders } from '../github/app-auth';
import type { PublisherConfig } from './service';
import { currentPromotion } from './promotion';
import { publicationDestination } from './destinations';
import { continueCancellation } from './cancellation';

const DispatchSchema = z.object({
  repository: z.string(),
  job_id: z.uuid(),
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
  dispatch_revision: z.string().regex(/^[a-f0-9]{40}$/),
  requested_by: z.string().regex(/^github:[1-9][0-9]*$/),
  github_login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  target: z.enum(['staging', 'production']),
});
const eligible = `FROM publication_runs pr JOIN publication_slots ps ON ps.job_id=pr.job_id
  JOIN publish_jobs j ON j.id=pr.job_id JOIN publication_inputs pi ON pi.job_id=j.id
  JOIN drafts d ON d.id=pi.draft_id JOIN user_roles u ON u.email=j.requested_by
  WHERE pr.job_id=? AND j.status='queued' AND pr.run_id IS NULL AND pr.reserved_run_id IS NULL AND d.status='active' AND u.active=1
    AND ((ps.target='staging' AND j.environment='staging' AND u.role IN ('publisher','administrator'))
      OR (ps.target='production' AND j.environment='production-merge' AND u.role='administrator'
        AND ${currentPromotion}))`;

/** Dispatch only captured jobs. A lost response leaves the same job and nonce retryable. */
export const MAX_DISPATCH_ATTEMPTS = 6;

export async function dispatchPublication(
  database: D1Database,
  config: PublisherConfig,
  jobId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  z.uuid().parse(jobId);
  const row = DispatchSchema.safeParse(
    await database
      .prepare(
        `SELECT j.repository,pr.job_id,pr.nonce,
    pr.dispatch_revision,j.requested_by,u.github_login,ps.target ${eligible}`,
      )
      .bind(jobId)
      .first(),
  );
  if (!row.success) throw new Error('PUBLISH_DISPATCH_UNAVAILABLE');
  const input = row.data;
  if (
    input.repository !==
    `PointCommunity/${publicationDestination(input.target, config.builderOrigin).repository}`
  )
    throw new Error('PUBLISH_DESTINATION_REJECTED');
  // Durable throttle prevents multiple browsers or uncertain POST acknowledgments
  // from creating an unbounded number of workflow runs.
  const reserved = await database
    .prepare(
      `UPDATE publication_runs
    SET dispatch_after=strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || (60 << dispatch_count) || ' seconds'),dispatch_count=dispatch_count+1,dispatch_error=NULL
    WHERE job_id=? AND dispatch_count<${MAX_DISPATCH_ATTEMPTS} AND dispatch_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS (SELECT 1 ${eligible} AND u.github_login=?)`,
    )
    .bind(jobId, jobId, input.github_login)
    .run();
  if (!reserved.meta.changes) throw new Error('PUBLISH_DISPATCH_BACKOFF');
  try {
    const request: typeof fetch = (url, init) =>
      fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    const name = publicationDestination(input.target, config.builderOrigin).repository;
    const token = await createPublisherToken({
      ...config,
      repository: name,
      fetcher: request,
      subject: input.requested_by,
      login: input.github_login,
    });
    const headers = { ...githubHeaders(token), 'content-type': 'application/json' };
    const api = `https://api.github.com/repos/PointCommunity/${name}`;
    const baseResponse = await request(`${api}/git/ref/heads/main`, { headers });
    if (!baseResponse.ok) throw new Error('PUBLISH_BASE_UNAVAILABLE');
    const base = z
      .object({ object: z.object({ sha: z.literal(input.dispatch_revision) }) })
      .safeParse(await baseResponse.json());
    if (!base.success) throw new Error('PUBLISH_BASE_CHANGED');
    // External permission checks can take time. Local revocation wins before dispatch.
    const current = await database
      .prepare(
        `SELECT 1 ${eligible}
      AND pr.nonce=? AND pr.dispatch_revision=? AND u.github_login=?`,
      )
      .bind(jobId, input.nonce, input.dispatch_revision, input.github_login)
      .first();
    if (!current) throw new Error('PUBLISH_DISPATCH_UNAVAILABLE');
    const response = await request(`${api}/dispatches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event_type: 'publish-candidate',
        client_payload: {
          jobId,
          nonce: input.nonce,
          builderOrigin: config.builderOrigin ?? 'https://builder.pointatx.org',
        },
      }),
    });
    if (response.status !== 204) {
      const retry = Number(response.headers.get('retry-after'));
      const seconds = Number.isFinite(retry) ? Math.min(3600, Math.max(60, Math.ceil(retry))) : 60;
      await database
        .prepare(
          "UPDATE publication_runs SET dispatch_after=MAX(dispatch_after,strftime('%Y-%m-%dT%H:%M:%fZ','now',?)) WHERE job_id=?",
        )
        .bind(`+${seconds} seconds`, jobId)
        .run();
      throw new Error('PUBLISH_DISPATCH_UNCONFIRMED');
    }
  } catch (error) {
    // Never bubble provider bodies, JWT parsing errors or credential-bearing requests.
    const code =
      error instanceof Error && /^PUBLISH_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'PUBLISH_DISPATCH_UNCONFIRMED';
    await database
      .prepare('UPDATE publication_runs SET dispatch_error=? WHERE job_id=?')
      .bind(code, jobId)
      .run();
    throw new Error(code);
  }
}

/** One of at most two held slots per invocation; idle cost does not grow with job history. */
export async function dispatchPendingPublication(
  database: D1Database,
  config: PublisherConfig,
  fetcher: typeof fetch = fetch,
  productionEnabled = false,
): Promise<void> {
  const cancellations = await database
    .prepare(
      `SELECT ps.job_id FROM publication_slots ps
    JOIN publish_jobs j ON j.id=ps.job_id JOIN publication_runs pr ON pr.job_id=j.id
    WHERE j.status='cancelled' AND json_extract(j.evidence_json,'$.cancellation.pending')=1
      AND pr.dispatch_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 2`,
    )
    .all<{ job_id: string }>();
  for (const cancellation of cancellations.results)
    await continueCancellation(database, cancellation.job_id, config, fetcher);
  const row = await database
    .prepare(
      `SELECT pr.job_id FROM publication_slots ps
    JOIN publication_runs pr ON pr.job_id=ps.job_id JOIN publish_jobs j ON j.id=ps.job_id
    JOIN publication_inputs pi ON pi.job_id=j.id JOIN drafts d ON d.id=pi.draft_id
    JOIN user_roles u ON u.email=j.requested_by
    WHERE (ps.target='staging' OR (?=1 AND ps.target='production')) AND j.status='queued' AND pr.run_id IS NULL AND pr.reserved_run_id IS NULL
      AND pr.dispatch_count<${MAX_DISPATCH_ATTEMPTS} AND pr.dispatch_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND d.status='active' AND u.active=1 AND ((ps.target='staging' AND u.role IN ('publisher','administrator'))
        OR (ps.target='production' AND u.role='administrator' AND ${currentPromotion}))
    ORDER BY pr.dispatch_after,pr.job_id LIMIT 1`,
    )
    .bind(productionEnabled ? 1 : 0)
    .first<{ job_id: string }>();
  if (!row) return;
  try {
    await dispatchPublication(database, config, row.job_id, fetcher);
  } catch (error) {
    if (error instanceof Error && /^PUBLISH_[A-Z_]+$/.test(error.message)) return;
    throw new Error('PUBLISH_DISPATCH_UNCONFIRMED');
  }
}
