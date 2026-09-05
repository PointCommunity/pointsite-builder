import { render, screen } from '@testing-library/react';
import { App, BuilderErrorBoundary } from '../../src/client/App';

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

  it('offers GitHub sign-in without exposing private data when no session exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            { code: 'UNAUTHENTICATED', message: 'Sign in with GitHub' },
            { status: 401 },
          ),
        ),
      ),
    );
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Sign in to PointSite Builder' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in with GitHub' })).toHaveAttribute(
      'href',
      '/auth/login',
    );
  });
});

it('contains unexpected rendering failures without implying the public site is affected', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const Broken = () => {
    throw new Error('test render failure');
  };
  render(
    <BuilderErrorBoundary>
      <Broken />
    </BuilderErrorBoundary>,
  );
  expect(screen.getByRole('heading', { name: 'Builder view interrupted' })).toBeVisible();
  expect(screen.getByText(/public website are unaffected/i)).toBeVisible();
  consoleError.mockRestore();
});
