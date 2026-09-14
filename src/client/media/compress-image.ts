import { inspectImage, validateImageUpload } from '../../server/media/policy';

const prepared = new WeakMap<File, Promise<File>>();

/** A shared promise keeps preview, upload and uncertain-request retries on identical bytes. */
export function compressImage(file: File, signal?: AbortSignal): Promise<File> {
  const existing = prepared.get(file);
  if (existing) return existing;
  const result = prepare(file, signal);
  prepared.set(file, result);
  void result.then(
    (output) => prepared.set(output, Promise.resolve(output)),
    () => prepared.delete(file),
  );
  return result;
}

async function prepare(file: File, signal?: AbortSignal): Promise<File> {
  signal?.throwIfAborted();
  if (!file.size || file.size > 20 * 1024 * 1024)
    throw new Error('Choose an image between 1 byte and 20 MiB before compression.');
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  const info = inspectImage(originalBytes);
  if (
    !info.width ||
    !info.height ||
    info.width > 8_000 ||
    info.height > 8_000 ||
    info.width * info.height > 32_000_000
  )
    throw new Error('Image exceeds 8,000 pixels per side or 32 megapixels.');
  const stem = file.name.replace(/\.[^.]*$/, '') || 'image';
  const normalized = new File([originalBytes], `${stem}.${info.extension}`, {
    type: info.contentType,
  });
  let bytes = originalBytes;
  let output = normalized;
  if (!info.animated) {
    const worker = new Worker(new URL('./compress-image.worker.ts', import.meta.url), {
      type: 'module',
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      const encoded = await new Promise<{ bytes: ArrayBuffer; width: number; height: number }>(
        (resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Image compression timed out. Try a smaller image.')),
            60_000,
          );
          abort = () => reject(new DOMException('Image selection cancelled', 'AbortError'));
          signal?.addEventListener('abort', abort, { once: true });
          worker.onerror = () =>
            reject(new Error('Image compression failed. Try choosing the image again.'));
          worker.onmessage = ({
            data,
          }: MessageEvent<{
            bytes: ArrayBuffer;
            width: number;
            height: number;
            error?: string;
          }>) => {
            if (data.error) reject(new Error(data.error));
            else resolve(data);
          };
          worker.postMessage({ file: normalized, lossless: info.lossless });
        },
      );
      const encodedBytes = new Uint8Array(encoded.bytes);
      const actual = inspectImage(encodedBytes);
      if (
        actual.contentType !== 'image/webp' ||
        actual.width !== encoded.width ||
        actual.height !== encoded.height ||
        !(
          (actual.width === info.width && actual.height === info.height) ||
          (actual.width === info.height && actual.height === info.width)
        )
      )
        throw new Error('Compressed image dimensions could not be verified.');
      if (encodedBytes.byteLength < originalBytes.byteLength) {
        bytes = encodedBytes;
        output = new File([bytes], `${stem}.webp`, { type: 'image/webp' });
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    }
  }
  validateImageUpload({
    filename: output.name,
    contentType: output.type,
    bytes,
    altText: 'Proposed image',
  });
  return output;
}
