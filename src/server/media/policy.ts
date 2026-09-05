const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 8_000;
const mimeByExtension = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
} as const;

type SupportedMime = (typeof mimeByExtension)[keyof typeof mimeByExtension];

export interface ImageUploadInput {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  altText: string;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function dimensionsFor(bytes: Uint8Array, mime: SupportedMime): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png') {
    if (bytes.length < 24 || !startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      throw new Error('PNG signature is invalid');
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === 'image/jpeg') {
    if (bytes.length < 4 || !startsWith(bytes, [0xff, 0xd8, 0xff]))
      throw new Error('JPEG signature is invalid');
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      )
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      offset += length + 2;
    }
    throw new Error('JPEG dimensions are missing');
  }
  if (mime === 'image/webp') {
    if (
      bytes.length < 30 ||
      ascii(bytes, 0, 4) !== 'RIFF' ||
      ascii(bytes, 8, 4) !== 'WEBP' ||
      ascii(bytes, 12, 4) !== 'VP8X'
    )
      throw new Error('WebP signature or dimensions are invalid');
    const uint24 = (offset: number) =>
      (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
    return { width: uint24(24) + 1, height: uint24(27) + 1 };
  }
  if (
    bytes.length < 32 ||
    ascii(bytes, 4, 4) !== 'ftyp' ||
    !['avif', 'avis'].includes(ascii(bytes, 8, 4))
  )
    throw new Error('AVIF signature is invalid');
  for (let offset = 4; offset + 16 <= bytes.length; offset += 1) {
    if (ascii(bytes, offset, 4) === 'ispe')
      return { width: view.getUint32(offset + 8), height: view.getUint32(offset + 12) };
  }
  throw new Error('AVIF dimensions are missing');
}

export function validateImageUpload(input: ImageUploadInput) {
  if (!input.altText.trim() || input.altText.trim().length > 300)
    throw new Error('Alternative text is required and must be at most 300 characters');
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_BYTES)
    throw new Error('Image must be between 1 byte and 5 MiB');
  const match = input.filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  const extension = match?.[1] as keyof typeof mimeByExtension | undefined;
  const expected = extension ? mimeByExtension[extension] : undefined;
  if (!extension || !expected) throw new Error('Image extension is not supported');
  if (input.contentType.toLowerCase() !== expected)
    throw new Error('Declared media type does not match the extension');
  const dimensions = dimensionsFor(input.bytes, expected);
  if (
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > MAX_DIMENSION ||
    dimensions.height > MAX_DIMENSION
  )
    throw new Error(`Image dimensions must be between 1 and ${MAX_DIMENSION} pixels`);
  return { contentType: expected, extension, ...dimensions };
}
