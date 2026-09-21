import { expect, it, vi } from 'vitest';
import { readPublicationActions } from '../../src/server/publish/progress';

const captured = {
  target: 'staging' as const,
  jobId: '10000000-0000-4000-8000-000000000084',
  requestedAt: '2026-09-21T12:00:00.500Z',
  sha: 'a'.repeat(40),
};
const providerRun = {
  id: 123,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'startup_failure',
  head_sha: captured.sha,
  head_branch: 'main',
  event: 'repository_dispatch',
  path: '.github/workflows/publish-candidate.yml',
  display_title: `Publish Staging candidate ${captured.jobId}`,
  created_at: '2026-09-21T12:00:00Z',
  repository: { id: 1357847426, full_name: 'PointCommunity/pointsite-staging' },
};

it('finds an exactly correlated startup failure before reservation, even with zero jobs', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation((url) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            (url instanceof Request ? url.url : url.toString()).includes('/jobs?')
              ? { total_count: 0, jobs: [] }
              : (url instanceof Request ? url.url : url.toString()).includes('/runs?')
                ? { total_count: 1, workflow_runs: [providerRun] }
                : providerRun,
          ),
        ),
      ),
    );
  const result = await readPublicationActions(captured, fetcher);
  expect(result.run).toMatchObject({ status: 'completed', conclusion: 'startup_failure' });
  expect(result.jobs).toEqual([]);
  expect(result.unavailable).toBeUndefined();
});

it.each([
  { display_title: 'Publish Staging candidate another-job' },
  { head_sha: 'b'.repeat(40) },
  { event: 'workflow_dispatch' },
  { path: '.github/workflows/other.yml' },
  { created_at: '2026-09-20T12:00:00Z' },
  { repository: { id: 1370792530, full_name: 'PointCommunity/pointsite-staging-canary' } },
])('never correlates a different publication identity: %j', async (change) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        total_count: 1,
        workflow_runs: [{ ...providerRun, ...change }],
      }),
    ),
  );
  const result = await readPublicationActions(captured, fetcher);
  expect(result.run).toBeUndefined();
  expect(result.unconfirmed).toBe(true);
});

it('does not choose one run from ambiguous dispatches', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        total_count: 2,
        workflow_runs: [providerRun, { ...providerRun, id: 124 }],
      }),
    ),
  );
  expect((await readPublicationActions(captured, fetcher)).unconfirmed).toBe(true);
});

it('reads only the recorded run attempt and rejects mismatched job identity', async () => {
  const input = {
    target: 'staging' as const,
    builderOrigin: 'https://builder-canary.eaglepass.io',
    runId: '123',
    attempt: '1',
    sha: 'a'.repeat(40),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...providerRun,
          repository: { id: 1370792530, full_name: 'PointCommunity/pointsite-staging-canary' },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          total_count: 1,
          jobs: [
            {
              id: 456,
              run_id: 123,
              run_attempt: 1,
              head_sha: input.sha,
              name: 'Publish',
              status: 'completed',
              conclusion: 'failure',
              steps: [
                { number: 1, name: 'Build website', status: 'completed', conclusion: 'failure' },
              ],
            },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            message: 'BUILD_FAILED: Bearer sensitive-token',
            path: 'scripts/publication.mts',
            start_line: 12,
          },
        ]),
      ),
    );
  const result = await readPublicationActions(input, fetcher);
  expect(fetcher.mock.calls[1][0]).toBe(
    'https://api.github.com/repos/PointCommunity/pointsite-staging-canary/actions/runs/123/attempts/1/jobs?per_page=100',
  );
  expect(result.jobs?.[0].steps[0].conclusion).toBe('failure');
  expect(result.jobs?.[0].errors?.[0]).toEqual({
    message: 'BUILD_FAILED: Bearer [redacted]',
    path: 'scripts/publication.mts',
    line: 12,
  });
  await readPublicationActions(input, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(3);
  const wrong = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        total_count: 1,
        jobs: [
          {
            id: 456,
            run_id: 999,
            run_attempt: 1,
            head_sha: input.sha,
            name: 'Other run',
            status: 'completed',
            conclusion: 'success',
            steps: [],
          },
        ],
      }),
    ),
  );
  expect((await readPublicationActions(input, wrong)).unavailable).toBe(
    'ACTIONS_STATUS_UNAVAILABLE',
  );
});

it('reports unavailable or rate-limited progress without exporting provider bodies or retrying aggressively', async () => {
  const input = { target: 'production' as const, runId: '123', attempt: '1', sha: 'a'.repeat(40) };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response('private provider error', { status: 429, headers: { 'retry-after': '600' } }),
    );
  const result = await readPublicationActions(input, fetcher);
  expect(result.unavailable).toBe('ACTIONS_RATE_LIMITED');
  expect(JSON.stringify(result)).not.toContain('private provider error');
  await readPublicationActions(input, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await readPublicationActions({ ...input, runId: '../other' }, fetcher)).unavailable).toBe(
    'ACTIONS_IDENTITY_UNAVAILABLE',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
