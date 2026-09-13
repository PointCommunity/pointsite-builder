// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createApp } from '../../src/server';
import { AuthenticationError } from '../../src/server/auth/github';
import { InMemoryRepository } from '../../src/server/repositories/memory';
import type { D1PublicationVerifier } from '../../src/server/publish/verification';
import type { Role } from '../../src/server/repositories/contracts';
import type { D1ProductionPublisher } from '../../src/server/publish/promotion';

const id = '30000000-0000-4000-8000-000000000001';
const url = `https://builder.pointatx.org/api/publish/verification/${id}`;
const headers = { authorization: 'Bearer signed-fixture' };

it.each(['staging', 'production'] as const)(
  'protects %s verification capture and status with current session authority',
  async (target) => {
    let role: Role = target === 'staging' ? 'publisher' : 'administrator';
    const verifier = {
      status: vi.fn().mockResolvedValue(null),
      capture: vi.fn().mockResolvedValue({ recovered: true, verificationId: id }),
      dispatch: vi.fn().mockRejectedValue(new Error('PUBLICATION_VERIFICATION_BACKOFF')),
    };
    const dependencies = {
      repository: new InMemoryRepository(),
      environment: 'test',
      version: 'test',
      authenticate: () => Promise.resolve({ email: 'github:12345', role }),
      publicationVerifier: verifier as unknown as D1PublicationVerifier,
      production: {} as D1ProductionPublisher,
    };
    const app = createApp(dependencies);
    const path = `https://builder.pointatx.org/api/publish/${target}/jobs/${id}/verification`;
    const mutationHeaders = {
      origin: 'https://builder.pointatx.org',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'idempotency-key': 'verification-capture-fixture',
    };
    const call = (extra = {}) =>
      app.request(path, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({ expectedAttempts: 2, ...extra }),
      });
    expect(await (await app.request(path)).json()).toEqual({ verification: null });
    expect(verifier.status).toHaveBeenCalledWith(id, target, 'github:12345');
    expect((await call()).status).toBe(202);
    expect(verifier.capture).toHaveBeenCalledWith({
      jobId: id,
      target,
      actor: 'github:12345',
      expectedAttempts: 2,
      idempotencyKey: 'verification-capture-fixture',
      requestId: expect.any(String) as string,
    });
    expect(verifier.dispatch).toHaveBeenCalledWith(id);
    verifier.capture.mockClear();
    expect((await call({ target: target === 'staging' ? 'production' : 'staging' })).status).toBe(
      422,
    );
    expect(
      (
        await app.request(path, {
          method: 'POST',
          headers: { ...mutationHeaders, origin: 'https://evil.example' },
          body: '{"expectedAttempts":2}',
        })
      ).status,
    ).toBe(403);
    for (role of (target === 'staging'
      ? ['viewer', 'editor']
      : ['viewer', 'editor', 'publisher']) as Role[]) {
      expect((await call()).status).toBe(403);
      expect((await app.request(path)).status).toBe(403);
    }
    expect(verifier.capture).not.toHaveBeenCalled();
    role = 'administrator';
    verifier.capture.mockRejectedValueOnce(new Error('private provider detail'));
    const failure = await call();
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('private provider detail');
    if (target === 'production')
      expect(
        (await createApp({ ...dependencies, production: undefined }).request(path)).status,
      ).toBe(403);
  },
);

it('exposes only bounded verification operations to machine credentials', async () => {
  const verifier = {
    reserve: vi.fn().mockResolvedValue({ reserved: true }),
    claim: vi.fn().mockResolvedValue({ claimed: true }),
    inputs: vi.fn().mockResolvedValue({ retained: 'public metadata' }),
    report: vi.fn().mockResolvedValue({ recorded: true }),
    finalize: vi.fn().mockResolvedValue({ verified: true }),
  };
  const authenticate = vi.fn(() => Promise.reject(new AuthenticationError()));
  const dependencies = {
    repository: new InMemoryRepository(),
    authenticate,
    environment: 'test',
    version: 'test',
    publicationVerifier: verifier as unknown as D1PublicationVerifier,
  };
  const app = createApp(dependencies);
  for (const operation of ['reserve', 'claim', 'finalize'] as const) {
    const response = await app.request(`${url}/${operation}`, { method: 'POST', headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(verifier[operation]).toHaveBeenCalledWith(id, 'signed-fixture');
    expect(
      (await app.request(`${url}/${operation}`, { method: 'POST', headers, body: '{}' })).status,
    ).toBe(401);
  }
  expect(await (await app.request(`${url}/inputs`, { headers })).json()).toEqual({
    retained: 'public metadata',
  });
  const report = { artifactDigest: 'a'.repeat(64), deploymentId: '123' };
  expect(
    (
      await app.request(`${url}/report`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(report),
      })
    ).status,
  ).toBe(200);
  expect(verifier.report).toHaveBeenCalledWith(id, 'signed-fixture', report);
  verifier.report.mockClear();
  expect((await app.request(`${url}/report`, { method: 'POST', headers, body: '{}' })).status).toBe(
    401,
  );
  expect(
    (
      await app.request(`${url}/report`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(8192) }),
      })
    ).status,
  ).toBe(409);
  expect(verifier.report).not.toHaveBeenCalled();
  for (const [name, value] of [
    ['cookie', 'session=fixture'],
    ['origin', 'https://builder.pointatx.org'],
    ['authorization', 'Basic fixture'],
  ])
    expect(
      (await app.request(`${url}/inputs`, { headers: { ...headers, [name]: value } })).status,
    ).toBe(401);
  expect((await app.request(`${url}/inputs?scope=extra`, { headers })).status).toBe(401);
  expect((await app.request(`${url.replace(id, 'invalid')}/inputs`, { headers })).status).toBe(401);
  expect(authenticate).not.toHaveBeenCalled();
  const log = vi.spyOn(console, 'error');
  verifier.inputs.mockRejectedValueOnce(new Error('private SQL nonce detail'));
  const failure = await app.request(`${url}/inputs`, { headers });
  expect(failure.status).toBe(409);
  expect(await failure.text()).not.toMatch(/private|SQL|nonce/);
  expect(log).not.toHaveBeenCalled();
  for (const path of ['authorize-deployment', 'build', 'assets/asset/chunks/0'])
    expect((await app.request(`${url}/${path}`, { method: 'POST', headers })).status).toBe(401);
  expect(authenticate).toHaveBeenCalledTimes(3);
  expect(
    (
      await createApp({ ...dependencies, publicationVerifier: undefined }).request(
        `${url}/inputs`,
        { headers },
      )
    ).status,
  ).toBe(503);
});
