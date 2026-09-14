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
    if (bytes.length < 25 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP')
      throw new Error('WebP signature or dimensions are invalid');
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      if (bits >>> 29) throw new Error('WebP version is not supported');
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (bytes.length < 30) throw new Error('WebP signature or dimensions are invalid');
    if (chunk === 'VP8 ' && ascii(bytes, 23, 3) === '\x9d\x01\x2a')
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    if (chunk !== 'VP8X') throw new Error('WebP signature or dimensions are invalid');
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

/** Inspect bytes before browser decoding; filenames and MIME declarations are not evidence. */
export function inspectImage(bytes: Uint8Array) {
  let contentType: SupportedMime;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) contentType = 'image/png';
  else if (startsWith(bytes, [0xff, 0xd8, 0xff])) contentType = 'image/jpeg';
  else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP')
    contentType = 'image/webp';
  else if (ascii(bytes, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(bytes, 8, 4)))
    contentType = 'image/avif';
  else throw new Error('Image format is unsupported or invalid. Choose JPEG, PNG, WebP or AVIF.');
  const dimensions = dimensionsFor(bytes, contentType);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let animated =
    contentType === 'image/webp' && ascii(bytes, 12, 4) === 'VP8X' && Boolean((bytes[20] ?? 0) & 2);
  if (contentType === 'image/png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      if (ascii(bytes, offset + 4, 4) === 'acTL') animated = true;
      const length = view.getUint32(offset);
      if (offset + length + 12 > bytes.length) break;
      offset += length + 12;
    }
  }
  if (contentType === 'image/avif') {
    const end = Math.min(view.getUint32(0), bytes.length);
    for (let offset = 8; offset + 4 <= end; offset += 4)
      if (ascii(bytes, offset, 4) === 'avis') animated = true;
  }
  return {
    ...dimensions,
    contentType,
    extension: contentType === 'image/jpeg' ? 'jpg' : contentType.slice(6),
    animated,
    lossless: contentType === 'image/png' || contentType === 'image/webp',
  };
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
