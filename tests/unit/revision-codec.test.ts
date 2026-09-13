// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { canonicalize, checksumDocument } from '../../src/site-kit/canonicalize';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { encodeRevision, decodeRevision } from '../../src/server/repositories/revision-codec';
import { MAX_DRAFT_DOCUMENT_BYTES } from '../../src/shared/draft-limits';

const bytes = (value: unknown) => new TextEncoder().encode(canonicalize(value));

it('reconstructs Unicode edits against one full checkpoint without chains', async () => {
  const document = structuredClone(defaultSiteDocument);
  const checkpoint = bytes(document);
  const full = await encodeRevision(checkpoint);
  expect(full.codec).toBe('gzip');
  expect(await decodeRevision(full, await checksumDocument(document))).toEqual(checkpoint);
  for (let index = 0; index < 32; index++) {
    document.pages[0].metadata.description = `Edit ${index}: résumé, 教会, 🌿.`;
    const current = bytes(document);
    const encoded = await encodeRevision(current, checkpoint);
    expect(encoded.codec).toBe('gzip-splice');
    expect(encoded.payload.byteLength).toBeLessThan(full.payload.byteLength);
    expect(await decodeRevision(encoded, await checksumDocument(document), checkpoint)).toEqual(
      current,
    );
  }
});

it('chooses a full snapshot when a splice costs more', async () => {
  const value = { title: 'Replacement' };
  const encoded = await encodeRevision(bytes(value), bytes({ content: 'Original' }));
  expect(encoded.codec).toBe('gzip');
  expect(await decodeRevision(encoded, await checksumDocument(value))).toEqual(bytes(value));
});

it('rejects corrupt data, wrong or missing bases, bad offsets and excessive decompression', async () => {
  const document = structuredClone(defaultSiteDocument);
  const checkpoint = bytes(document);
  document.site.shortName = 'Next';
  const encoded = await encodeRevision(bytes(document), checkpoint);
  const checksum = await checksumDocument(document);
  await expect(decodeRevision(encoded, checksum)).rejects.toThrow('REVISION_PAYLOAD_CORRUPT');
  const wrong = checkpoint.slice();
  wrong[0] ^= 1;
  await expect(decodeRevision(encoded, checksum, wrong)).rejects.toThrow(
    'REVISION_PAYLOAD_CORRUPT',
  );
  await expect(
    decodeRevision({ ...encoded, prefixBytes: -1 }, checksum, checkpoint),
  ).rejects.toThrow();
  await expect(
    decodeRevision({ ...encoded, suffixBytes: MAX_DRAFT_DOCUMENT_BYTES }, checksum, checkpoint),
  ).rejects.toThrow();
  await expect(
    decodeRevision({ ...encoded, payload: encoded.payload.subarray(0, 8) }, checksum, checkpoint),
  ).rejects.toThrow();
  await expect(decodeRevision(encoded, '0'.repeat(64), checkpoint)).rejects.toThrow();
  await expect(encodeRevision(new Uint8Array(MAX_DRAFT_DOCUMENT_BYTES + 1))).rejects.toThrow(
    'REVISION_TOO_LARGE',
  );
  const bomb = {
    codec: 'gzip' as const,
    payload: gzipSync(new Uint8Array(MAX_DRAFT_DOCUMENT_BYTES + 1)),
    rawBytes: MAX_DRAFT_DOCUMENT_BYTES,
    prefixBytes: 0,
    suffixBytes: 0,
  };
  await expect(decodeRevision(bomb, checksum)).rejects.toThrow('REVISION_PAYLOAD_CORRUPT');
});
