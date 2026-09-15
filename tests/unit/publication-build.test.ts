// @vitest-environment node
import { commitPublicationBuild, publicationJson } from '../../src/server/publish/build-proof';
import { publicationGitHubFixture } from '../fixtures/publication-github';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('does not retry denied access, rate limits or a provider delay beyond the request budget', async () => {
  for (const status of [401, 403, 429, 503]) {
    const jobId = crypto.randomUUID();
    const fixture = await publicationGitHubFixture(jobId, 'a'.repeat(64));
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response('private body', { status, headers: { 'retry-after': '60' } })),
    );
    await expect(
      commitPublicationBuild({
        ...fixture,
        jobId,
        repository: 'pointsite-staging',
        assetPaths: [],
        token: 'fixture',
        guard: async () => {},
        fetcher,
      }),
    ).rejects.toThrow('PUBLICATION_COMMIT_UNCONFIRMED');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fixture.state.mutations).toBe(0);
    expect(console.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('"stage":"candidate-ref"'),
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private body');
  }
});

it('retries temporary candidate visibility and lost acknowledgements without a second mutation', async () => {
  vi.useRealTimers();
  for (const failure of ['visibility', 'lost-response']) {
    const jobId = crypto.randomUUID();
    const fixture = await publicationGitHubFixture(jobId, 'a'.repeat(64));
    const guard = vi.fn(async () => {});
    let reads = 0;
    if (failure === 'lost-response') fixture.state.failure = failure;
    const pending = commitPublicationBuild({
      ...fixture,
      jobId,
      repository: 'pointsite-staging',
      assetPaths: [],
      token: 'fixture',
      guard,
      fetcher: async (url, init) => {
        if (
          (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).includes(
            '/git/ref/heads/builder-publications/',
          ) &&
          ++reads === 1 &&
          failure === 'visibility'
        )
          return new Response('private-provider-body', { status: 404 });
        return fixture.fetcher(url, init);
      },
    });
    await expect(pending).resolves.toBeUndefined();
    expect(fixture.state.mutations).toBe(1);
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-');
  }
});

it('cancels commit work within the shared request budget before any mutation', async () => {
  const jobId = crypto.randomUUID();
  const fixture = await publicationGitHubFixture(jobId, 'a'.repeat(64));
  const controller = new AbortController();
  let guards = 0;
  await expect(
    commitPublicationBuild({
      ...fixture,
      jobId,
      repository: 'pointsite-staging',
      assetPaths: [],
      token: 'fixture',
      signal: controller.signal,
      guard: (signal) => {
        expect(signal).toBe(controller.signal);
        if (++guards === 2) controller.abort();
        return Promise.resolve();
      },
      fetcher: (url, init) => {
        expect(init?.signal?.aborted).toBe(false);
        return fixture.fetcher(url, init);
      },
    }),
  ).rejects.toThrow('PUBLICATION_COMMIT_UNCONFIRMED');
  expect(fixture.state.mutations).toBe(0);
  expect(guards).toBe(2);
});

it('bounds transient retries and stops if authority changes during backoff', async () => {
  for (const revoked of [false, true]) {
    const jobId = crypto.randomUUID();
    const fixture = await publicationGitHubFixture(jobId, 'a'.repeat(64));
    let attempts = 0;
    const pending = commitPublicationBuild({
      ...fixture,
      jobId,
      repository: 'pointsite-staging',
      assetPaths: [],
      token: 'fixture',
      guard: () => {
        if (revoked && attempts) return Promise.reject(new Error('private revocation'));
        return Promise.resolve();
      },
      fetcher: () => {
        attempts++;
        return Promise.resolve(new Response('private body', { status: 503 }));
      },
    });
    const rejected = expect(pending).rejects.toThrow('PUBLICATION_COMMIT_UNCONFIRMED');
    await vi.runAllTimersAsync();
    await rejected;
    expect(attempts).toBe(revoked ? 1 : 3);
    expect(fixture.state.mutations).toBe(0);
  }
});

it('commits only verified publication files with atomic expected-base protection and lost-response recovery', async () => {
  const jobId = crypto.randomUUID();
  const fixture = await publicationGitHubFixture(jobId, 'a'.repeat(64));
  const guard = vi.fn(() => Promise.resolve());
  const input = {
    ...fixture,
    jobId,
    repository: 'pointsite-staging' as const,
    assetPaths: [],
    token: 'fixture-installation-token',
    guard,
  };
  fixture.state.failure = 'provider';
  await expect(commitPublicationBuild(input)).rejects.toThrow('PUBLICATION_COMMIT_UNCONFIRMED');
  expect(fixture.state.main).toBe(fixture.baseSha);
  fixture.state.failure = '';
  await commitPublicationBuild(input);
  expect(fixture.state.mutations).toBe(1);
  expect(guard).toHaveBeenCalledTimes(4);
});

it('rejects changed Git identity, unexpected files, revocation and concurrent branch resets', async () => {
  for (const failure of [
    'branch',
    'parent',
    'merge',
    'truncated',
    'deleted',
    'unrelated',
    'missing',
    'symlink',
    'extra',
    'blob',
    'repository',
    'provider',
    'revocation',
    'reset',
  ]) {
    const jobId = crypto.randomUUID();
    const fixture = await publicationGitHubFixture(jobId, 'a'.repeat(64));
    fixture.state.failure = failure;
    if (failure === 'reset')
      fixture.state.beforeMutation = () => {
        fixture.state.main = '0'.repeat(40);
        return Promise.resolve();
      };
    await expect(
      commitPublicationBuild({
        ...fixture,
        jobId,
        repository: 'pointsite-staging',
        assetPaths: [],
        token: 'fixture-installation-token',
        guard: () =>
          failure === 'revocation' ? Promise.reject(new Error('revoked')) : Promise.resolve(),
      }),
      failure,
    ).rejects.toThrow('PUBLICATION_COMMIT_UNCONFIRMED');
    expect(fixture.state.mutations).toBe(0);
  }
  await expect(publicationJson(new Response('x'.repeat(101)), 100)).rejects.toThrow(
    'PUBLICATION_GITHUB_UNCONFIRMED',
  );
});
