import { z } from 'zod';
import { createInstallationToken, githubHeaders } from '../github/app-auth';
import type { PublisherConfig } from './service';

const DispatchSchema = z.object({
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
  WHERE pr.job_id=? AND j.status='queued' AND pr.run_id IS NULL AND d.status='active' AND u.active=1
    AND ((ps.target='staging' AND j.environment='staging' AND u.role IN ('publisher','administrator'))
      OR (ps.target='production' AND j.environment='production-merge' AND u.role='administrator'))`;

/** Dispatch only captured jobs. A lost response leaves the same job and nonce retryable. */
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
        `SELECT pr.job_id,pr.nonce,
    pr.dispatch_revision,j.requested_by,u.github_login,ps.target ${eligible}`,
      )
      .bind(jobId)
      .first(),
  );
  if (!row.success) throw new Error('PUBLISH_DISPATCH_UNAVAILABLE');
  const input = row.data;
  // Durable throttle prevents multiple browsers or uncertain POST acknowledgments
  // from creating an unbounded number of workflow runs.
  const reserved = await database
    .prepare(
      `UPDATE publication_runs
    SET dispatch_after=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),dispatch_count=dispatch_count+1
    WHERE job_id=? AND dispatch_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
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
    const name = input.target === 'staging' ? 'pointsite-staging' : 'pointsite';
    const token = await createInstallationToken({ ...config, repository: name, fetcher: request });
    const headers = { ...githubHeaders(token), 'content-type': 'application/json' };
    const api = `https://api.github.com/repos/PointCommunity/${name}`;
    const permissionResponse = await request(
      `${api}/collaborators/${encodeURIComponent(input.github_login)}/permission`,
      { headers },
    );
    if (!permissionResponse.ok) throw new Error('PUBLISH_GITHUB_AUTHORITY_CHANGED');
    const permission = z
      .object({
        permission: z.enum(['admin', 'maintain', 'write']),
        user: z.object({ id: z.number().int().positive() }),
      })
      .safeParse(await permissionResponse.json());
    if (!permission.success || `github:${permission.data.user.id}` !== input.requested_by)
      throw new Error('PUBLISH_GITHUB_AUTHORITY_CHANGED');
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
        client_payload: { jobId, nonce: input.nonce },
      }),
    });
    if (response.status !== 204) {
      const retry = Number(response.headers.get('retry-after'));
      const seconds = Number.isFinite(retry) ? Math.min(3600, Math.max(60, Math.ceil(retry))) : 60;
      await database
        .prepare(
          "UPDATE publication_runs SET dispatch_after=strftime('%Y-%m-%dT%H:%M:%fZ','now',?) WHERE job_id=?",
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
    throw new Error(code);
  }
}
