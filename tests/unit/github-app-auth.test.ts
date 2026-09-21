// @vitest-environment node
import { exportPKCS8, generateKeyPair } from 'jose';
import { createInstallationToken } from '../../src/server/github/app-auth';

it('requests Actions write only for cancellation, without contents write', async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(Response.json({ token: 'fixture-installation-token', expires_at: 'fixture' })),
  );
  await createInstallationToken({
    appId: '123',
    installationId: '456',
    privateKey: await exportPKCS8(keys.privateKey),
    repository: 'pointsite-staging',
    cancelActions: true,
    fetcher,
  });
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({
    repositories: ['pointsite-staging'],
    permissions: { contents: 'read', actions: 'write', metadata: 'read' },
  });
});

it.each([true, false])(
  'scopes installation access to one repository with readOnly=%s',
  async (readOnly) => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const fetcher = vi.fn(() =>
      Promise.resolve(
        Response.json({
          token: 'fixture-installation-token',
          expires_at: 'fixture',
        }),
      ),
    );
    await createInstallationToken({
      appId: '123',
      installationId: '456',
      privateKey: await exportPKCS8(keys.privateKey),
      repository: 'pointsite-staging',
      readOnly,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/app/installations/456/access_tokens',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          repositories: ['pointsite-staging'],
          permissions: { contents: readOnly ? 'read' : 'write', checks: 'read', metadata: 'read' },
        }),
      }),
    );
  },
);
