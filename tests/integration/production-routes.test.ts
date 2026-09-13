// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createApp } from '../../src/server';
import { InMemoryRepository } from '../../src/server/repositories/memory';
import type { D1ProductionPublisher } from '../../src/server/publish/promotion';
import type { Role } from '../../src/server/repositories/contracts';

const jobId = '30000000-0000-4000-8000-000000000001';
const input = {
  stagingJobId: jobId,
  approvalId: '30000000-0000-4000-8000-000000000002',
  tuple: {
    siteId: 'pointsite',
    revisionId: '30000000-0000-4000-8000-000000000003',
    revisionChecksum: 'a'.repeat(64),
    schemaVersion: 1,
    rendererVersion: '1.0.0',
    candidateChecksum: 'b'.repeat(64),
    stagingBaseSha: 'c'.repeat(40),
    stagingCommitSha: 'd'.repeat(40),
    productionBaseSha: 'e'.repeat(40),
    publicationProtocol: 2,
    workflowRevision: 'f'.repeat(40),
    artifactDigest: 'a'.repeat(64),
  },
};
const headers = {
  origin: 'https://builder.pointatx.org',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
  'idempotency-key': 'production-request-fixture',
};

it.each(['capture', 'recovery'] as const)(
  'protects Production %s before invoking the service',
  async (operation) => {
    const production = {
      capture: vi.fn().mockResolvedValue({ id: jobId, status: 'queued' }),
      recoverQueued: vi.fn().mockResolvedValue({ recovered: true, jobId }),
    };
    let role: Role = 'administrator';
    const dependencies = {
      repository: new InMemoryRepository(),
      environment: 'test',
      version: 'test',
      authenticate: () =>
        Promise.resolve({ email: 'github:12345', role, repositoryPermission: 'write' as const }),
      production: production as unknown as D1ProductionPublisher,
    };
    const app = createApp(dependencies);
    const url = `https://builder.pointatx.org/api/publish/production${operation === 'recovery' ? `/jobs/${jobId}/recovery` : ''}`;
    const body =
      operation === 'capture' ? input : { action: 'retry-captured', expectedAttempts: 0 };
    const call = () => app.request(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const service = operation === 'capture' ? production.capture : production.recoverQueued;
    expect((await call()).status).toBe(operation === 'capture' ? 202 : 200);
    expect(service).toHaveBeenCalledWith({
      ...body,
      ...(operation === 'recovery' ? { jobId } : {}),
      actor: 'github:12345',
      requestId: expect.any(String) as string,
      idempotencyKey: headers['idempotency-key'],
    });
    service.mockClear();
    for (role of ['viewer', 'editor', 'publisher'] as const)
      expect((await call()).status).toBe(403);
    role = 'administrator';
    for (const extra of [{ actor: 'github:54321' }, { workflowRevision: '0'.repeat(40) }]) {
      expect(
        (
          await app.request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...body, ...extra }),
          })
        ).status,
      ).toBe(422);
    }
    for (const changed of [
      { origin: 'https://untrusted.invalid' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      expect(
        (
          await app.request(url, {
            method: 'POST',
            headers: { ...headers, ...changed },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await app.request(url, {
          method: 'POST',
          headers: { ...headers, 'idempotency-key': 'short' },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(400);
    expect((await app.request(url)).status).toBe(404);
    expect(service).not.toHaveBeenCalled();
    const disabled = createApp({ ...dependencies, production: undefined });
    expect(
      (await disabled.request(url, { method: 'POST', headers, body: JSON.stringify(body) })).status,
    ).toBe(403);
    expect(service).not.toHaveBeenCalled();
    service.mockRejectedValueOnce(new Error('PUBLICATION_RECOVERY_CHANGED'));
    const changed = await call();
    expect(changed.status).toBe(409);
    expect(await changed.text()).not.toContain('github:');
    service.mockRejectedValueOnce(new Error('provider-secret-fixture'));
    const unavailable = await call();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('provider-secret-fixture');
  },
);
