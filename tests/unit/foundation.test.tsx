import { render, screen } from '@testing-library/react';
import { App } from '../../src/client/App';

describe('PointSite Builder foundation', () => {
  it('identifies the private authoring surface and production lock', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              url.endsWith('/me')
                ? { email: 'viewer@pointatx.org', role: 'viewer' }
                : { items: [] },
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }),
    );
    render(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Website drafts' })).toBeVisible();
    expect(screen.getByText(/production remains locked/i)).toBeVisible();
    expect(screen.getByText('viewer@pointatx.org')).toBeVisible();
  });
});
