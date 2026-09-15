import { MAX_DRAFT_DOCUMENT_BYTES } from '../../shared/draft-limits';

export interface RevisionEncoding {
  codec: 'gzip' | 'gzip-splice';
  payload: Uint8Array;
  rawBytes: number;
  prefixBytes: number;
  suffixBytes: number;
}

const MAX_COMPRESSED_BYTES = MAX_DRAFT_DOCUMENT_BYTES + 1024;
const invalid = () => new Error('REVISION_PAYLOAD_CORRUPT');

async function transform(bytes: Uint8Array, compress: boolean, limit: number): Promise<Uint8Array> {
  const source = new Response(Uint8Array.from(bytes).buffer).body!;
  const reader = source
    .pipeThrough(compress ? new CompressionStream('gzip') : new DecompressionStream('gzip'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw invalid();
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw invalid();
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** The caller supplies only a full checkpoint; there are no recursive delta chains. */
export async function encodeRevision(
  bytes: Uint8Array,
  checkpoint?: Uint8Array,
): Promise<RevisionEncoding> {
  if (!bytes.byteLength || bytes.byteLength > MAX_DRAFT_DOCUMENT_BYTES)
    throw new Error('REVISION_TOO_LARGE');
  const full: RevisionEncoding = {
    codec: 'gzip',
    payload: await transform(bytes, true, MAX_COMPRESSED_BYTES),
    rawBytes: bytes.byteLength,
    prefixBytes: 0,
    suffixBytes: 0,
  };
  if (!checkpoint) return full;
  if (!checkpoint.byteLength || checkpoint.byteLength > MAX_DRAFT_DOCUMENT_BYTES) throw invalid();
  let prefixBytes = 0;
  let suffixBytes = 0;
  const length = Math.min(bytes.byteLength, checkpoint.byteLength);
  while (prefixBytes < length && bytes[prefixBytes] === checkpoint[prefixBytes]) prefixBytes++;
  while (
    suffixBytes < length - prefixBytes &&
    bytes[bytes.byteLength - suffixBytes - 1] ===
      checkpoint[checkpoint.byteLength - suffixBytes - 1]
  )
    suffixBytes++;
  const payload = await transform(
    bytes.subarray(prefixBytes, bytes.byteLength - suffixBytes),
    true,
    MAX_COMPRESSED_BYTES,
  );
  // Account for the immutable base UUID and splice offsets, not just the compressed slice.
  return payload.byteLength + 64 < full.payload.byteLength
    ? { codec: 'gzip-splice', payload, rawBytes: bytes.byteLength, prefixBytes, suffixBytes }
    : full;
}

/** Verify exact canonical bytes before JSON parsing or schema migration. */
export async function decodeRevision(
  encoded: RevisionEncoding,
  checksum: string,
  checkpoint?: Uint8Array,
): Promise<Uint8Array> {
  const { codec, payload, rawBytes, prefixBytes, suffixBytes } = encoded;
  if (
    !['gzip', 'gzip-splice'].includes(codec) ||
    !/^[a-f0-9]{64}$/.test(checksum) ||
    !Number.isInteger(rawBytes) ||
    rawBytes <= 0 ||
    rawBytes > MAX_DRAFT_DOCUMENT_BYTES ||
    !Number.isInteger(prefixBytes) ||
    prefixBytes < 0 ||
    !Number.isInteger(suffixBytes) ||
    suffixBytes < 0 ||
    payload.byteLength === 0 ||
    payload.byteLength > MAX_COMPRESSED_BYTES ||
    prefixBytes + suffixBytes > rawBytes
  )
    throw invalid();
  if (codec === 'gzip' && (prefixBytes !== 0 || suffixBytes !== 0)) throw invalid();
  if (
    codec === 'gzip-splice' &&
    (!checkpoint ||
      checkpoint.byteLength > MAX_DRAFT_DOCUMENT_BYTES ||
      prefixBytes + suffixBytes > checkpoint.byteLength)
  )
    throw invalid();
  const slice = await transform(payload, false, rawBytes - prefixBytes - suffixBytes);
  if (slice.byteLength + prefixBytes + suffixBytes !== rawBytes) throw invalid();
  const result = new Uint8Array(rawBytes);
  if (codec === 'gzip-splice') {
    result.set(checkpoint!.subarray(0, prefixBytes));
    result.set(checkpoint!.subarray(checkpoint!.byteLength - suffixBytes), rawBytes - suffixBytes);
  }
  result.set(slice, prefixBytes);
  const observed = [...new Uint8Array(await crypto.subtle.digest('SHA-256', result))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (observed !== checksum) throw invalid();
  return result;
}
