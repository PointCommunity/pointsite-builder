import { z } from 'zod';
import { createPublisherToken, githubHeaders } from '../github/app-auth';
import { publicationDestination } from './destinations';
import { publicationJson } from './build-proof';
import type { PublisherConfig } from './service';

/** Fence runner callbacks before checking native execution or releasing an unreserved slot. */
export async function continueCancellation(
  database: D1Database,
  jobId: string,
  config?: PublisherConfig,
  fetcher: typeof fetch = fetch,
) {
  const row = await database
    .prepare(
      `SELECT ps.target,j.repository,j.requested_at,
    pr.dispatch_revision,pr.reserved_run_id,pr.reserved_run_attempt,
    json_extract(j.evidence_json,'$.cancellation.actor') AS actor,u.github_login
    FROM publication_slots ps JOIN publish_jobs j ON j.id=ps.job_id
    JOIN publication_runs pr ON pr.job_id=j.id
    LEFT JOIN user_roles u ON u.email=json_extract(j.evidence_json,'$.cancellation.actor')
      AND u.active=1 AND (u.role='administrator' OR (ps.target='staging' AND u.role='publisher'))
    WHERE j.id=? AND j.status='cancelled' AND pr.deploy_authorized_at IS NULL
      AND json_extract(j.evidence_json,'$.cancellation.pending')=1`,
    )
    .bind(jobId)
    .first<{
      target: 'staging' | 'production';
      repository: string;
      requested_at: string;
      dispatch_revision: string;
      reserved_run_id: string | null;
      reserved_run_attempt: string | null;
      actor: string;
      github_login: string | null;
    }>();
  if (!row) return;
  const claimed = await database
    .prepare(
      `UPDATE publication_runs
    SET dispatch_after=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds')
    WHERE job_id=? AND dispatch_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(jobId)
    .run();
  if (!claimed.meta.changes) return;
  try {
    if (!config || !row.github_login) throw new Error('Cancellation authority unavailable');
    const destination = publicationDestination(row.target, config.builderOrigin);
    if (row.repository !== `PointCommunity/${destination.repository}`)
      throw new Error('Lane changed');
    const request: typeof fetch = (url, init) =>
      fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    const token = await createPublisherToken({
      ...config,
      repository: destination.repository,
      subject: row.actor,
      login: row.github_login,
      cancelActions: true,
      fetcher: request,
    });
    const headers = { ...githubHeaders(token), 'cache-control': 'no-cache' };
    const api = `https://api.github.com/repos/${row.repository}/actions/runs`;
    const read = async (url: string) => {
      const response = await request(url, { headers });
      if (!response.ok) throw new Error('Native status unavailable');
      return publicationJson(response, 524_288);
    };
    const title =
      row.target === 'staging' ? 'Publish Staging candidate' : 'Publish accepted public candidate';
    const schema = z.object({
      id: z.number().int().positive().safe(),
      run_attempt: z.number().int().positive(),
      status: z.string(),
      conclusion: z.string().nullable(),
      head_sha: z.literal(row.dispatch_revision),
      head_branch: z.literal('main'),
      event: z.literal('repository_dispatch'),
      display_title: z.literal(`${title} ${jobId}`),
      created_at: z
        .string()
        .refine(
          (value) => Date.parse(value) >= Math.floor(Date.parse(row.requested_at) / 1000) * 1000,
        ),
      path: z.enum([
        '.github/workflows/publish-candidate.yml',
        '.github/workflows/publish-candidate.yml@main',
        '.github/workflows/publish-candidate.yml@refs/heads/main',
      ]),
      repository: z.object({
        id: z
          .number()
          .int()
          .refine((value) => String(value) === destination.id),
        full_name: z.literal(row.repository),
      }),
    });
    const list = z
      .object({
        total_count: z.number().int().nonnegative(),
        workflow_runs: z.array(z.unknown()).max(100),
      })
      .parse(
        await read(
          `${api}?event=repository_dispatch&head_sha=${row.dispatch_revision}&created=${encodeURIComponent(`>=${new Date(Math.floor(Date.parse(row.requested_at) / 1000) * 1000).toISOString()}`)}&per_page=100`,
        ),
      );
    if (list.total_count !== list.workflow_runs.length) throw new Error('Truncated run listing');
    const matched = list.workflow_runs.map((value) => schema.safeParse(value));
    const ids = new Set(
      matched.flatMap((parsed) => (parsed.success ? [String(parsed.data.id)] : [])),
    );
    if (row.reserved_run_id) ids.add(row.reserved_run_id);
    const unidentified = ids.size === 0;
    // Startup failures can lose the dynamic run title before any runner reserves this job.
    // A complete empty/terminal listing plus the atomic unreserved guard below is sufficient:
    // even a delayed dispatch cannot reserve a cancelled job. Never cancel an unnamed run.
    const terminalScope = schema.omit({ display_title: true }).extend({
      status: z.literal('completed'),
      conclusion: z.string().min(1),
    });
    if (
      list.workflow_runs.some(
        (value, index) => !matched[index].success && !terminalScope.safeParse(value).success,
      )
    )
      throw new Error('Unidentified execution may still be active');
    let terminal = true;
    for (const id of ids) {
      const run = schema.parse(await read(`${api}/${id}`));
      if (
        String(run.id) !== id ||
        (id === row.reserved_run_id && run.run_attempt < Number(row.reserved_run_attempt))
      )
        throw new Error('Run identity changed');
      if (run.status === 'completed' && run.conclusion) continue;
      terminal = false;
      // Recheck local authority after provider reads; never cancel another lane or a deployed job.
      const current = await database
        .prepare(
          `SELECT 1 FROM publish_jobs j
        JOIN publication_slots ps ON ps.job_id=j.id JOIN publication_runs pr ON pr.job_id=j.id
        JOIN user_roles u ON u.email=? WHERE j.id=? AND j.status='cancelled'
        AND pr.deploy_authorized_at IS NULL AND ps.target=? AND u.active=1
        AND (u.role='administrator' OR (ps.target='staging' AND u.role='publisher'))`,
        )
        .bind(row.actor, jobId, row.target)
        .first();
      if (!current) throw new Error('Cancellation authority changed');
      const response = await request(`${api}/${id}/cancel`, { method: 'POST', headers });
      if (response.status !== 202 && response.status !== 409)
        throw new Error('Cancellation not acknowledged');
    }
    await database.batch([
      database
        .prepare(
          `UPDATE publish_jobs SET evidence_json=json_remove(evidence_json,'$.cancellation.error') WHERE id=?`,
        )
        .bind(jobId),
      ...(terminal
        ? [
            database
              .prepare(
                `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM publish_jobs j
          JOIN publication_runs pr ON pr.job_id=j.id JOIN publication_slots ps ON ps.job_id=j.id
          WHERE j.id=? AND j.status='cancelled' AND pr.deploy_authorized_at IS NULL
            AND (?=0 OR (pr.reserved_run_id IS NULL AND pr.run_id IS NULL
              AND pr.build_json IS NULL AND pr.deployment_json IS NULL AND j.result_sha IS NULL)))
          THEN 'true' ELSE 'cancellation changed' END)`,
              )
              .bind(jobId, unidentified ? 1 : 0),
            database
              .prepare(
                `UPDATE publish_jobs SET evidence_json=json_set(evidence_json,'$.cancellation.pending',0) WHERE id=?`,
              )
              .bind(jobId),
            database.prepare('DELETE FROM publication_slots WHERE job_id=?').bind(jobId),
          ]
        : []),
    ]);
  } catch {
    await database
      .prepare(
        `UPDATE publish_jobs SET evidence_json=json_set(evidence_json,
      '$.cancellation.error','PUBLICATION_CANCELLATION_UNCONFIRMED') WHERE id=? AND status='cancelled'`,
      )
      .bind(jobId)
      .run();
  }
}
