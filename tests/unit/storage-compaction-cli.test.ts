// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  compactionMode,
  runCompaction,
  verifyReaderDeployment,
  verifyReaderDatabase,
} from '../../scripts/compact-storage';

const source = 'a'.repeat(40);
const versionId = '00000000-0000-4000-8000-000000000001';
const deploymentId = '00000000-0000-4000-8000-000000000002';
const deployments = [
  {
    id: deploymentId,
    created_on: '2026-09-12T00:00:00.000Z',
    versions: [{ version_id: versionId, percentage: 100 }],
  },
];
const health = {
  ok: true,
  environment: 'production',
  sourceRevision: source,
  sourceClean: true,
  workerVersionId: versionId,
  storageReaders: ['legacy', 'compact-v1'],
  storageWriteFormat: 'compact-v1',
};

it('requires explicit read-only, verification or apply mode and an exact source revision', () => {
  expect(compactionMode(['--status'])).toEqual({ mode: 'status' });
  expect(compactionMode(['--verify-reader', source])).toEqual({
    mode: 'verify-reader',
    sourceRevision: source,
  });
  expect(compactionMode(['--apply', source])).toEqual({ mode: 'apply', sourceRevision: source });
  for (const args of [
    [],
    ['--apply'],
    ['--apply', 'main'],
    ['--status', '--apply'],
    ['--apply', source, '--force'],
  ])
    expect(() => compactionMode(args)).toThrow('STORAGE_COMPACTION_ARGUMENTS');
});

it('accepts only the exact compatible reader receiving all Production traffic', () => {
  expect(verifyReaderDeployment(deployments, health, source, true)).toEqual({
    deploymentId,
    versionId,
    sourceRevision: source,
    storageWriteFormat: 'compact-v1',
  });
  expect(
    verifyReaderDeployment(deployments, { ...health, storageWriteFormat: 'legacy' }, source)
      .storageWriteFormat,
  ).toBe('legacy');
  for (const changed of [
    { ...health, ok: false },
    { ...health, sourceClean: false },
    { ...health, environment: 'development' },
    { ...health, sourceRevision: 'b'.repeat(40) },
    { ...health, workerVersionId: crypto.randomUUID() },
    { ...health, workerVersionId: null },
    { ...health, storageReaders: ['legacy'] },
    { ...health, storageReaders: ['compact-v1'] },
    { ...health, storageWriteFormat: 'legacy' },
  ])
    expect(() => verifyReaderDeployment(deployments, changed, source, true)).toThrow(
      'STORAGE_READER_UNVERIFIED',
    );
  for (const changed of [
    [],
    [{ ...deployments[0], versions: [{ version_id: versionId, percentage: 99 }] }],
    [
      {
        ...deployments[0],
        versions: [
          { version_id: versionId, percentage: 50 },
          { version_id: crypto.randomUUID(), percentage: 50 },
        ],
      },
    ],
    [...deployments, { ...deployments[0], id: crypto.randomUUID() }],
  ])
    expect(() => verifyReaderDeployment(changed, health, source)).toThrow(
      'STORAGE_READER_UNVERIFIED',
    );
  const previous = {
    ...deployments[0],
    id: crypto.randomUUID(),
    created_on: '2026-09-11T00:00:00Z',
    versions: [{ version_id: crypto.randomUUID(), percentage: 100 }],
  };
  expect(verifyReaderDeployment([...deployments, previous], health, source).deploymentId).toBe(
    deploymentId,
  );
});

it('checks the deployed version binds DB to the intended database', () => {
  const binding = { name: 'DB', type: 'd1', id: 'd4f44410-3f61-47bd-976a-5595973fa6f1' };
  const metadata = { id: versionId, resources: { bindings: [binding] } };
  expect(() => verifyReaderDatabase(metadata, versionId)).not.toThrow();
  for (const changed of [
    {},
    { ...metadata, id: crypto.randomUUID() },
    { ...metadata, resources: { bindings: [] } },
    { ...metadata, resources: { bindings: [{ ...binding, id: crypto.randomUUID() }] } },
    { ...metadata, resources: { bindings: [{ ...binding, type: 'kv_namespace' }] } },
    { ...metadata, resources: { bindings: [binding, binding] } },
  ])
    expect(() => verifyReaderDatabase(changed, versionId)).toThrow('STORAGE_READER_DATABASE');
});

it('status never writes; apply refuses an unverified reader before the first conversion', async () => {
  const compaction = {
    status: vi.fn().mockResolvedValue({ state: 'pending', revisions: 1, receipts: 1 }),
    step: vi.fn(),
  };
  const verify = vi.fn().mockRejectedValue(new Error('STORAGE_READER_UNVERIFIED'));
  await runCompaction('status', compaction, verify, () => {});
  expect(verify).not.toHaveBeenCalled();
  await expect(runCompaction('apply', compaction, verify, () => {})).rejects.toThrow(
    'STORAGE_READER_UNVERIFIED',
  );
  expect(compaction.step).not.toHaveBeenCalled();
});

it('stops after a changed deployment and preserves completed atomic steps for resume', async () => {
  const proof = verifyReaderDeployment(deployments, health, source, true);
  const compaction = {
    status: vi.fn().mockResolvedValue({ state: 'pending', revisions: 100, receipts: 0 }),
    step: vi.fn().mockResolvedValue({ processed: 'revision' }),
  };
  const verify = vi
    .fn()
    .mockResolvedValueOnce(proof)
    .mockResolvedValue({ ...proof, deploymentId: crypto.randomUUID() });
  await expect(runCompaction('apply', compaction, verify, () => {})).rejects.toThrow(
    'STORAGE_READER_CHANGED',
  );
  expect(compaction.step).toHaveBeenCalledTimes(8);
  compaction.status
    .mockResolvedValueOnce({ state: 'pending', revisions: 1, receipts: 0 })
    .mockResolvedValue({ state: 'complete', revisions: 0, receipts: 0 });
  compaction.step
    .mockResolvedValueOnce({ processed: 'revision' })
    .mockResolvedValue({ processed: null });
  verify.mockResolvedValue(proof);
  const report = vi.fn();
  await runCompaction('apply', compaction, verify, report);
  expect(report).toHaveBeenLastCalledWith({ state: 'complete', revisions: 0, receipts: 0 });
});

it('reports exact processed steps without recounting history for every batch', async () => {
  const proof = verifyReaderDeployment(deployments, health, source, true);
  let remaining = 17;
  const compaction = {
    status: vi
      .fn()
      .mockResolvedValueOnce({ state: 'pending', revisions: 17, receipts: 0 })
      .mockResolvedValue({ state: 'complete', revisions: 0, receipts: 0 }),
    step: vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ processed: remaining-- > 0 ? 'revision' : null }),
      ),
  };
  const verify = vi.fn().mockResolvedValue(proof);
  const report = vi.fn();
  await runCompaction('apply', compaction, verify, report);
  expect(compaction.status).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledWith({ state: 'running', processed: 8 });
  expect(report).toHaveBeenCalledWith({ state: 'running', processed: 16 });
  expect(report).toHaveBeenLastCalledWith({ state: 'complete', revisions: 0, receipts: 0 });
  expect(verify).toHaveBeenCalledTimes(4);
});
