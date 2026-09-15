import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { resolve } from 'node:path';

const policy =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob: https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.google.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function createPublicAssets(publicRoot: string): Pick<Fetcher, 'fetch'> {
  const app = new Hono();
  app.get('/assets/*', serveStatic({ root: resolve(publicRoot) }));
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (
        !/^\/assets\/(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_-]*\.(?:avif|jpe?g|png|webp)$/.test(
          path,
        ) ||
        path.startsWith('/assets/builder/')
      )
        return new Response(null, { status: 404 });
      return app.fetch(request);
    },
  };
}

export function createNativeHandler(options: {
  origin: string;
  publicRoot: string;
  runtime: { fetch(request: Request): Promise<Response> };
  ready(): Promise<void>;
  feedbackOrigin?: 'https://pointview-canary.eaglepass.io' | 'https://pointview.eaglepass.io';
}) {
  const origin = new URL(options.origin);
  const root = resolve(options.publicRoot);
  const app = new Hono();
  app.use(
    '*',
    bodyLimit({
      maxSize: 8 * 1024 * 1024,
      onError: (context) => context.json({ code: 'REQUEST_TOO_LARGE' }, 413),
    }),
  );
  for (const path of ['/api/*', '/auth/*', '/assets/builder/*']) {
    app.all(path, (context) => options.runtime.fetch(context.req.raw));
  }
  app.get('/assets/*', serveStatic({ root }));
  app.all('/assets/*', (context) => context.notFound());
  app.get('*', async (context, next) => {
    if (context.req.path.split('/').some((segment) => segment.startsWith('.')))
      return context.notFound();
    return serveStatic({ root, path: 'index.html' })(context, next);
  });
  app.onError(() => new Response(null, { status: 500 }));

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (/[\\%]/.test(pathname) || pathname.includes('\0') || pathname.split('/').includes('..'))
      return new Response(null, { status: 400 });
    let response: Response;
    if (['GET', 'HEAD'].includes(request.method) && ['/healthz', '/readyz'].includes(pathname)) {
      let ready = true;
      if (pathname === '/readyz') {
        try {
          await options.ready();
        } catch {
          ready = false;
        }
      }
      response = Response.json(pathname === '/readyz' ? { ready } : { ok: true }, {
        status: ready ? 200 : 503,
      });
    } else {
      if (url.host !== origin.host) return new Response(null, { status: 421 });
      // Trust only the configured origin. Forwarded headers cannot choose OAuth or CSRF origins.
      url.protocol = origin.protocol;
      url.pathname = pathname;
      response = await app.fetch(new Request(url, request));
    }
    const headers = new Headers(response.headers);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
    headers.set('x-frame-options', 'DENY');
    headers.set('cross-origin-resource-policy', 'same-origin');
    if (!headers.has('content-security-policy'))
      headers.set(
        'content-security-policy',
        policy + (options.feedbackOrigin ? ` ${options.feedbackOrigin}` : ''),
      );
    if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
    return new Response(request.method === 'HEAD' ? null : response.body, {
      status: response.status,
      headers,
    });
  };
}

export async function startNativeServer(
  fetch: (request: Request) => Promise<Response>,
  options: { hostname: string; port: number },
): Promise<{ server: Server; stop(): Promise<void> }> {
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = serve({ fetch, ...options, overrideGlobalObjects: false }, () =>
      resolve(listener as Server),
    );
    listener.once('error', reject);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  let stopping: Promise<void> | undefined;
  return {
    server,
    stop: () =>
      (stopping ??= new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => server.closeAllConnections(), 30_000);
        deadline.unref();
        server.close((error) => {
          clearTimeout(deadline);
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      })),
  };
}
