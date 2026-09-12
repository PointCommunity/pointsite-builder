// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server';
import type { StagingPublisher } from '../../src/server/publish/service';
import { InMemoryRepository } from '../../src/server/repositories/memory';
import type { Role } from '../../src/server/repositories/contracts';

const jobId = '30000000-0000-4000-8000-000000000001';
const headers = {
  origin: 'https://builder.pointatx.org',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
  'idempotency-key': 'continue-publication-test',
};
const running = {
  environment: 'staging',
  jobId,
  status: 'running',
  uploaded: 20,
  total: 102,
  candidateChecksum: 'a'.repeat(64),
};
function setup(role: Role = 'publisher') {
  const publisher = {
    continuePublication: vi.fn().mockResolvedValue(running),
    getJob: vi.fn().mockResolvedValue({ id: jobId, status: 'running' }),
    publish: vi.fn().mockResolvedValue(running),
  };
  const app = createApp({
    repository: new InMemoryRepository(),
    authenticate: () =>
      Promise.resolve({ email: 'publisher@pointatx.org', role, repositoryPermission: 'write' }),
    publisher: publisher as unknown as StagingPublisher,
    environment: 'test',
    version: 'test',
  });
  return { app, publisher };
}
describe('publication continuation API', () => {
  it('uses explicit protected POSTs and returns accepted progress', async () => {
    const { app, publisher } = setup();
    const response = await app.request(
      `https://builder.pointatx.org/api/publish/jobs/${jobId}/continue`,
      { method: 'POST', headers, body: '{}' },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(running);
    expect(publisher.continuePublication).toHaveBeenCalledWith(
      jobId,
      'publisher@pointatx.org',
      expect.any(String),
    );
    publisher.continuePublication.mockClear();
    const read = await app.request(`https://builder.pointatx.org/api/publish/jobs/${jobId}`);
    expect(read.status).toBe(200);
    expect(publisher.continuePublication).not.toHaveBeenCalled();
    expect(
      (await app.request(`https://builder.pointatx.org/api/publish/jobs/${jobId}/continue`)).status,
    ).toBe(404);
  });
  it('denies cross-site continuation and users without publication authority', async () => {
    const { app, publisher } = setup();
    const denied = await app.request(
      `https://builder.pointatx.org/api/publish/jobs/${jobId}/continue`,
      { method: 'POST', headers: { ...headers, origin: 'https://attacker.invalid' }, body: '{}' },
    );
    expect(denied.status).toBe(403);
    expect(publisher.continuePublication).not.toHaveBeenCalled();
    const reader = setup('viewer');
    expect(
      (
        await reader.app.request(
          `https://builder.pointatx.org/api/publish/jobs/${jobId}/continue`,
          { method: 'POST', headers, body: '{}' },
        )
      ).status,
    ).toBe(403);
    expect(reader.publisher.continuePublication).not.toHaveBeenCalled();
  });
  it('returns conflict when a saved revision no longer matches', async () => {
    const { app, publisher } = setup();
    publisher.continuePublication.mockRejectedValue(new Error('DRAFT_REVISION_DRIFT'));
    const response = await app.request(
      `https://builder.pointatx.org/api/publish/jobs/${jobId}/continue`,
      { method: 'POST', headers, body: '{}' },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'DRAFT_REVISION_DRIFT' });
  });
});
