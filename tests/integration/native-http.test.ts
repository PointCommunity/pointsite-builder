// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { createNativeHandler, startNativeServer } from '../../server/http';

const cleanups: (() => Promise<void>)[] = [];
// Node fetch normalizes Host. Use the native HTTP client to exercise ingress Host validation.
function fetch(
  url: string,
  options: {
    headers?: Record<string, string>;
    method?: string;
    body?: Uint8Array;
    redirect?: string;
  } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      { method: options.method, headers: options.headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
          }
          resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }));
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
test('real HTTP serves only public assets, preserves cookies, enforces limits and shuts down', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'builder-native-http-'));
  cleanups.push(() => rm(directory, { recursive: true }));
  await mkdir(join(directory, 'assets/builder'), { recursive: true });
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><title>PointSite Builder</title><div id="root"></div>',
  );
  await writeFile(join(directory, 'assets/app.js'), 'console.log("fixture")');
  await writeFile(join(directory, 'assets/builder/private.jpg'), 'private');
  const handler = createNativeHandler({
    origin: 'https://builder-canary.eaglepass.io',
    publicRoot: directory,
    ready: async () => {},
    runtime: {
      fetch: async (request) => {
        if (new URL(request.url).pathname.startsWith('/assets/builder/'))
          return new Response('denied', { status: 401 });
        if (new URL(request.url).pathname === '/auth/callback') {
          const headers = new Headers();
          headers.append('set-cookie', 'one=1; Path=/; Secure; HttpOnly');
          headers.append('set-cookie', 'two=2; Path=/; Secure; HttpOnly');
          return new Response(null, { status: 302, headers });
        }
        await request.arrayBuffer();
        return Response.json({ origin: new URL(request.url).origin });
      },
    },
  });
  const started = await startNativeServer(handler, { hostname: '127.0.0.1', port: 0 });
  cleanups.push(() => started.stop());
  const address = started.server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { host: 'builder-canary.eaglepass.io' };
  const html = await fetch(base, { headers });
  expect(html.status).toBe(200);
  expect(await html.text()).toContain('PointSite Builder');
  expect(html.headers.get('content-security-policy')).toContain("default-src 'self'");
  const head = await fetch(`${base}/assets/app.js`, { method: 'HEAD', headers });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  expect((await fetch(`${base}/assets/missing.js`, { headers })).status).toBe(404);
  expect((await fetch(`${base}/assets/builder/private.jpg`, { headers })).status).toBe(401);
  expect((await fetch(`${base}/assets/%62uilder/private.jpg`, { headers })).status).toBe(401);
  expect((await fetch(`${base}/.env`, { headers })).status).toBe(404);
  expect((await fetch(base, { headers: { host: 'attacker.example' } })).status).toBe(421);
  const api = await fetch(`${base}/api/me`, {
    headers: { ...headers, 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' },
  });
  expect(await api.json()).toEqual({ origin: 'https://builder-canary.eaglepass.io' });
  const callback = await fetch(`${base}/auth/callback`, { headers, redirect: 'manual' });
  expect(callback.headers.getSetCookie()).toHaveLength(2);
  expect(
    (
      await fetch(`${base}/api/save`, {
        headers,
        method: 'POST',
        body: new Uint8Array(8 * 1024 * 1024 + 1),
      })
    ).status,
  ).toBe(413);
  expect((await fetch(`${base}/readyz`)).status).toBe(200);
  await started.stop();
  await expect(fetch(base)).rejects.toThrow();
});

test('readiness fails closed while liveness remains available', async () => {
  const handler = createNativeHandler({
    origin: 'http://127.0.0.1:3000',
    publicRoot: '/missing',
    ready: () => Promise.reject(new Error('private failure detail')),
    runtime: { fetch: () => Promise.resolve(new Response('fixture')) },
  });
  const response = await handler(new Request('http://probe.internal/readyz'));
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('{"ready":false}');
  expect((await handler(new Request('http://probe.internal/healthz'))).status).toBe(200);
});
