// @vitest-environment node
import { validateImageUpload } from '../../src/server/media/policy';

function png(width = 640, height = 480) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width = 640, height = 480) {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x08,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    0xff,
    0xd9,
  ]);
}

function webp(width = 640, height = 480) {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('VP8X'), 12);
  const write24 = (offset: number, value: number) => {
    const encoded = value - 1;
    bytes[offset] = encoded & 255;
    bytes[offset + 1] = (encoded >> 8) & 255;
    bytes[offset + 2] = (encoded >> 16) & 255;
  };
  write24(24, width);
  write24(27, height);
  return bytes;
}

function avif(width = 640, height = 480) {
  const bytes = new Uint8Array(36);
  const text = new TextEncoder();
  bytes.set(text.encode('ftyp'), 4);
  bytes.set(text.encode('avif'), 8);
  bytes.set(text.encode('ispe'), 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(24, width);
  view.setUint32(28, height);
  return bytes;
}

describe('media upload policy', () => {
  it('accepts a bounded PNG whose extension, declaration, and signature agree', () => {
    expect(
      validateImageUpload({
        filename: 'gathering.png',
        contentType: 'image/png',
        bytes: png(),
        altText: 'People gathering around a table',
      }),
    ).toEqual({ contentType: 'image/png', extension: 'png', width: 640, height: 480 });
  });

  it.each([
    [
      'missing alt text',
      { filename: 'a.png', contentType: 'image/png', bytes: png(), altText: ' ' },
    ],
    [
      'unsupported extension',
      { filename: 'a.svg', contentType: 'image/png', bytes: png(), altText: 'Alt' },
    ],
    [
      'signature mismatch',
      { filename: 'a.jpg', contentType: 'image/jpeg', bytes: png(), altText: 'Alt' },
    ],
    [
      'oversized dimensions',
      { filename: 'a.png', contentType: 'image/png', bytes: png(9000, 10), altText: 'Alt' },
    ],
  ])('rejects %s', (_name, input) => {
    expect(() => validateImageUpload(input)).toThrow();
  });

  it('rejects files over five MiB before parsing', () => {
    expect(() =>
      validateImageUpload({
        filename: 'a.png',
        contentType: 'image/png',
        bytes: new Uint8Array(5 * 1024 * 1024 + 1),
        altText: 'Alt',
      }),
    ).toThrow('5 MiB');
  });

  it.each([
    ['photo.jpg', 'image/jpeg', jpeg(), 640, 480],
    ['photo.webp', 'image/webp', webp(), 640, 480],
    ['photo.avif', 'image/avif', avif(), 640, 480],
  ])('reads dimensions from supported %s bytes', (filename, contentType, bytes, width, height) => {
    expect(validateImageUpload({ filename, contentType, bytes, altText: 'Photo' })).toMatchObject({
      width,
      height,
      contentType,
    });
  });
});
