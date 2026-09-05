// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { buildCandidate } from '../../src/server/publish/candidate';
import type { DraftRecord } from '../../src/server/repositories/contracts';

function draft(): DraftRecord {
  const document = structuredClone(defaultSiteDocument);
  document.media.push({
    id: '99999999-9999-4999-8999-999999999999',
    sourcePath: '/assets/builder/99999999-9999-4999-8999-999999999999.png',
    alt: 'Uploaded',
  });
  return {
    id: '10000000-0000-4000-8000-000000000001',
    siteId: 'pointsite',
    name: 'Candidate',
    status: 'active',
    latestRevisionId: '20000000-0000-4000-8000-000000000001',
    document,
    revision: {
      id: '20000000-0000-4000-8000-000000000001',
      draftId: '10000000-0000-4000-8000-000000000001',
      sequence: 1,
      parentRevisionId: null,
      checksum: 'a'.repeat(64),
      document,
      label: null,
      schemaVersion: 1,
      rendererVersion: document.rendererVersion,
      createdBy: 'editor',
      createdAt: '2026-09-05T00:00:00Z',
    },
    createdBy: 'editor',
    createdAt: '2026-09-05T00:00:00Z',
    updatedAt: '2026-09-05T00:00:00Z',
    deletedAt: null,
  };
}

it('packages only referenced builder media under the strict staging path', async () => {
  const media = {
    read: vi
      .fn()
      .mockResolvedValue({
        bytes: Uint8Array.from([1, 2, 3]),
        contentType: 'image/png',
        filename: 'upload.png',
      }),
  };
  const candidate = await buildCandidate(draft(), media as never);
  expect(candidate.files).toContainEqual({
    path: 'public/assets/builder/99999999-9999-4999-8999-999999999999.png',
    content: 'AQID',
    encoding: 'base64',
  });
  expect(media.read).toHaveBeenCalledWith('99999999-9999-4999-8999-999999999999');
});
