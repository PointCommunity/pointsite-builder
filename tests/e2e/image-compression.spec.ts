import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type * as Compression from '../../src/client/media/compress-image';

test('compresses real renamed image bytes and preserves lossless pixels, alpha and dimensions', async ({
  page,
}) => {
  await page.route('**/compression-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Image compression test</title>',
    }),
  );
  await page.goto('/compression-test');
  const result = await page.evaluate(async () => {
    const path = '/src/client/media/compress-image.ts';
    const { compressImage } = (await import(/* @vite-ignore */ path)) as typeof Compression;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 384;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#507020';
    context.fillRect(0, 0, 400, 300);
    context.fillStyle = 'rgba(200, 40, 20, 0.5)';
    context.fillRect(100, 100, 400, 280);
    const original = await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), 'image/png'),
    );
    const source = new File([original], 'renamed.unusual', { type: 'text/plain' });
    const compressed: File = await compressImage(source);
    const decoded = await createImageBitmap(compressed);
    const output = document.createElement('canvas');
    output.width = decoded.width;
    output.height = decoded.height;
    const outputContext = output.getContext('2d')!;
    outputContext.drawImage(decoded, 0, 0);
    const before = context.getImageData(0, 0, 512, 384).data;
    const after = outputContext.getImageData(0, 0, 512, 384).data;
    const maxDelta = before.reduce(
      (maximum, value, index) => Math.max(maximum, Math.abs(value - after[index])),
      0,
    );
    const alphaEqual = before.every((value, index) => index % 4 !== 3 || value === after[index]);
    const opaqueEqual = before.every(
      (value, index) => before[index - (index % 4) + 3] !== 255 || value === after[index],
    );
    decoded.close();
    const jpeg = await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 1),
    );
    const photo: File = await compressImage(new File([jpeg], 'photo.unknown'));
    const recompressed: File = await compressImage(new File([compressed], 'existing.webp'));
    return {
      source: original.size,
      bytes: compressed.size,
      type: compressed.type,
      name: compressed.name,
      width: output.width,
      height: output.height,
      maxDelta,
      alphaEqual,
      opaqueEqual,
      jpegSource: jpeg.size,
      jpegBytes: photo.size,
      jpegType: photo.type,
      webpBytes: recompressed.size,
    };
  });
  expect(result).toMatchObject({
    type: 'image/webp',
    name: 'renamed.webp',
    width: 512,
    height: 384,
    alphaEqual: true,
    opaqueEqual: true,
    jpegType: 'image/webp',
  });
  expect(result.maxDelta).toBeLessThanOrEqual(2);
  expect(result.bytes).toBeLessThan(result.source);
  expect(result.jpegBytes).toBeLessThan(result.jpegSource);
  expect(result.webpBytes).toBeLessThanOrEqual(result.bytes);
});

test('compresses AVIF and honors JPEG orientation without shrinking displayed dimensions', async ({
  page,
}) => {
  await page.route('**/compression-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Image compression test</title>',
    }),
  );
  await page.goto('/compression-test');
  const inputs = await Promise.all(
    ['upload-avif.avif', 'upload-oriented.jpg'].map(async (name) => ({
      name,
      bytes: Array.from(await readFile(new URL(`../fixtures/${name}`, import.meta.url))),
    })),
  );
  const results = await page.evaluate(async (inputs) => {
    const path = '/src/client/media/compress-image.ts';
    const { compressImage } = (await import(/* @vite-ignore */ path)) as typeof Compression;
    const results = [];
    for (const input of inputs) {
      const output: File = await compressImage(
        new File([new Uint8Array(input.bytes)], 'misnamed.image'),
      );
      const bitmap = await createImageBitmap(output);
      results.push({
        width: bitmap.width,
        height: bitmap.height,
        smaller: output.size <= input.bytes.length,
        type: output.type,
      });
      bitmap.close();
    }
    return results;
  }, inputs);
  expect(results[0]).toMatchObject({ width: 96, height: 64, smaller: true });
  expect(results[1]).toMatchObject({ width: 64, height: 96, smaller: true, type: 'image/webp' });
});
