import { expect, it, vi } from 'vitest';
import { readPublicationActions } from '../../src/server/publish/progress';

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
  expect(fetcher.mock.calls[0][0]).toBe(
    'https://api.github.com/repos/PointCommunity/pointsite-staging-canary/actions/runs/123/attempts/1/jobs?per_page=100',
  );
  expect(result.jobs?.[0].steps[0].conclusion).toBe('failure');
  expect(result.jobs?.[0].errors?.[0]).toEqual({
    message: 'BUILD_FAILED: Bearer [redacted]',
    path: 'scripts/publication.mts',
    line: 12,
  });
  await readPublicationActions(input, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(2);
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
