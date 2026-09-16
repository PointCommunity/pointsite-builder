// @vitest-environment node
import { commitPublicationBuild, publicationJson } from '../../src/server/publish/build-proof';
import { publicationGitHubFixture } from '../fixtures/publication-github';
import { publicationDestinations } from '../../src/server/publish/destinations';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(['staging', 'canary', 'production', 'publicCanary'] as const)(
  'reconciles ambiguous HTTP 200 mutation responses for %s without duplicate publication',
  async (target) => {
    vi.useRealTimers();
    for (const response of ['internal', 'untyped', 'malformed', 'lost-acknowledgement']) {
      const jobId = crypto.randomUUID();
      const fixture = await publicationGitHubFixture(jobId, 'a'.repeat(64), [], target);
      const guard = vi.fn(async () => {});
      let updates = 0;
      const pending = commitPublicationBuild({
        ...fixture,
        jobId,
        repository: publicationDestinations[target].repository,
        assetPaths: [],
        token: 'fixture',
        guard,
        fetcher: async (url, init) => {
          if (url === 'https://api.github.com/graphql' && ++updates === 1) {
            if (response === 'lost-acknowledgement') await fixture.fetcher(url, init);
            const headers = { 'x-github-request-id': '7EEB:23CA4:DDA240:2D448A1:6AAAF968' };
            return response === 'malformed'
              ? new Response('{', { headers })
              : Response.json(
                  {
                    data: null,
                    errors: [
                      {
                        ...(response === 'internal' ? { type: 'INTERNAL' } : {}),
                        message: 'private provider details and credentials must not escape',
                      },
                    ],
                  },
                  { headers },
                );
          }
          return fixture.fetcher(url, init);
        },
      });
      const resolved = expect(pending).resolves.toBeUndefined();
      await resolved;
      expect(fixture.state.main).toBe(fixture.build.commitSha);
      expect(fixture.state.mutations).toBe(1);
      expect(updates).toBe(response === 'lost-acknowledgement' ? 1 : 2);
      expect(guard.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private provider');
      expect(console.warn).toHaveBeenLastCalledWith(
        expect.stringContaining('7EEB:23CA4:DDA240:2D448A1:6AAAF968'),
      );
    }
  },
  10_000,
);

it.each(['persistent', 'revoked', 'base-changed'])(
  'stops ambiguous GraphQL retries safely when %s',
  async (failure) => {
    vi.useRealTimers();
    const jobId = crypto.randomUUID();
    const fixture = await publicationGitHubFixture(jobId, 'a'.repeat(64));
    let updates = 0;
    let guards = 0;
    await expect(
      commitPublicationBuild({
        ...fixture,
        jobId,
        repository: 'pointsite-staging',
        assetPaths: [],
        token: 'fixture',
        guard: () => {
          if (++guards > 2 && failure === 'revoked') throw new Error('Authority revoked');
          return Promise.resolve();
        },
        fetcher: (url, init) => {
          if (url === 'https://api.github.com/graphql') {
            updates++;
            if (failure === 'base-changed') fixture.state.main = '0'.repeat(40);
            return Promise.resolve(
              Response.json({ errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] }),
            );
          }
          return fixture.fetcher(url, init);
        },
      }),
    ).rejects.toThrow('PUBLICATION_COMMIT_UNCONFIRMED');
    expect(updates).toBe(failure === 'persistent' ? 3 : 1);
    expect(fixture.state.mutations).toBe(0);
    expect(fixture.state.main).toBe(failure === 'base-changed' ? '0'.repeat(40) : fixture.baseSha);
  },
  10_000,
);

it('reconciles a stale main read after acknowledgement without another mutation', async () => {
  vi.useRealTimers();
  const jobId = crypto.randomUUID();
  const fixture = await publicationGitHubFixture(jobId, 'a'.repeat(64));
  let reads = 0;
  await commitPublicationBuild({
    ...fixture,
    jobId,
    repository: 'pointsite-staging',
    assetPaths: [],
    token: 'fixture',
    guard: async () => {},
    fetcher: (url, init) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (path.endsWith('/git/ref/heads/main') && ++reads === 2)
        return Promise.resolve(Response.json({ object: { sha: fixture.baseSha } }));
      return fixture.fetcher(url, init);
    },
  });
  expect(fixture.state.mutations).toBe(1);
  expect(reads).toBe(3);
});

it.each(['FORBIDDEN', 'RATE_LIMITED', 'UNPROCESSABLE', 'NOT_FOUND', 'GRAPHQL_VALIDATION_FAILED'])(
  'does not retry explicit GraphQL rejection %s',
  async (type) => {
    const jobId = crypto.randomUUID();
    const fixture = await publicationGitHubFixture(jobId, 'a'.repeat(64));
    let updates = 0;
    await expect(
      commitPublicationBuild({
        ...fixture,
        jobId,
        repository: 'pointsite-staging',
        assetPaths: [],
        token: 'fixture',
        guard: async () => {},
        fetcher: (url, init) => {
          if (url === 'https://api.github.com/graphql') {
            updates++;
            return Promise.resolve(
              Response.json(
                { errors: [{ type, message: 'private details' }] },
                { headers: { 'x-github-request-id': 'private-credential' } },
              ),
            );
          }
          return fixture.fetcher(url, init);
        },
      }),
    ).rejects.toThrow('PUBLICATION_COMMIT_UNCONFIRMED');
    expect(updates).toBe(1);
    expect(fixture.state.mutations).toBe(0);
    expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining(type));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private');
  },
);

it.each(['remaining', 'secondary', 'delay', 'invalid-delay'])(
  'respects provider throttling signaled by %s',
  async (kind) => {
    const jobId = crypto.randomUUID();
    const fixture = await publicationGitHubFixture(jobId, 'a'.repeat(64));
    let updates = 0;
    await expect(
      commitPublicationBuild({
        ...fixture,
        jobId,
        repository: 'pointsite-staging',
        assetPaths: [],
        token: 'fixture',
        guard: async () => {},
        fetcher: (url, init) => {
          if (url === 'https://api.github.com/graphql') {
            updates++;
            const headers: Record<string, string> =
              kind === 'remaining'
                ? { 'x-ratelimit-remaining': '0' }
                : kind === 'delay'
                  ? { 'retry-after': '60' }
                  : kind === 'invalid-delay'
                    ? { 'retry-after': 'invalid' }
                    : {};
            return Promise.resolve(
              Response.json(
                {
                  errors: [
                    {
                      message:
                        kind === 'secondary'
                          ? 'You have exceeded a secondary rate limit. private details'
                          : 'private details',
                    },
                  ],
                },
                { headers },
              ),
            );
          }
          return fixture.fetcher(url, init);
        },
      }),
    ).rejects.toThrow('PUBLICATION_COMMIT_UNCONFIRMED');
    expect(updates).toBe(1);
    expect(fixture.state.mutations).toBe(0);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private');
  },
);

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
