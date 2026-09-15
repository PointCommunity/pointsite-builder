// @vitest-environment node
import { commitPublicationBuild, publicationJson } from '../../src/server/publish/build-proof';
import { publicationGitHubFixture } from '../fixtures/publication-github';

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
  fixture.state.failure = 'lost-response';
  await expect(commitPublicationBuild(input)).rejects.toThrow('PUBLICATION_COMMIT_UNCONFIRMED');
  expect(fixture.state.main).toBe(fixture.build.commitSha);
  fixture.state.failure = '';
  await commitPublicationBuild(input);
  expect(fixture.state.mutations).toBe(1);
  expect(guard).toHaveBeenCalledTimes(2);
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
