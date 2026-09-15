// @vitest-environment node
import { exportPKCS8, generateKeyPair } from 'jose';
import { createInstallationToken } from '../../src/server/github/app-auth';

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
