import encode from '@jsquash/webp/encode';

self.onmessage = async ({ data }: MessageEvent<{ file: File; lossless: boolean }>) => {
  let bitmap: ImageBitmap | undefined;
  let canvas: OffscreenCanvas | undefined;
  try {
    bitmap = await createImageBitmap(data.file);
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width > 8_000 ||
      bitmap.height > 8_000 ||
      bitmap.width * bitmap.height > 32_000_000
    )
      throw new Error('Image exceeds 8,000 pixels per side or 32 megapixels.');
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!context) throw new Error('Image processing is unavailable in this browser.');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const bytes = await encode(pixels, {
      quality: 90,
      lossless: data.lossless ? 1 : 0,
      exact: 1,
      use_sharp_yuv: 1,
    });
    self.postMessage({ bytes, width: bitmap.width, height: bitmap.height }, { transfer: [bytes] });
  } catch {
    self.postMessage({
      error: 'Image could not be decoded or compressed. Try another JPEG, PNG, WebP or AVIF image.',
    });
  } finally {
    bitmap?.close();
    if (canvas) canvas.width = canvas.height = 1;
  }
};
