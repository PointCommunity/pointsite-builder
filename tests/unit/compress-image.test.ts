// @vitest-environment node
import { compressImage } from '../../src/client/media/compress-image';

function png(size = 100, width = 2, height = 3) {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}
function webp(width = 2, height = 3) {
  const bytes = new Uint8Array(25);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBPVP8L'), 8);
  bytes[20] = 0x2f;
  new DataView(bytes.buffer).setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return bytes.buffer;
}
let reply: { bytes: ArrayBuffer; width: number; height: number; error?: string };
let workers: FakeWorker[];
class FakeWorker {
  onmessage?: (event: { data: typeof reply }) => void;
  onerror?: () => void;
  terminate = vi.fn();
  postMessage = vi.fn(() => {
    queueMicrotask(() => this.onmessage?.({ data: reply }));
  });
  constructor() {
    workers.push(this);
  }
}
beforeEach(() => {
  workers = [];
  reply = { bytes: webp(), width: 2, height: 3 };
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('compresses by actual bytes regardless of extension, preserves dimensions and reuses exact output for retries', async () => {
  const source = new File([png()], 'photo.wrong', { type: 'text/plain' });
  const result = await compressImage(source);
  expect(result.name).toBe('photo.webp');
  expect(result.type).toBe('image/webp');
  expect(result.size).toBe(25);
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array(reply.bytes));
  expect(workers[0].postMessage.mock.calls[0]).toMatchObject([{ lossless: true }]);
  expect(await compressImage(source)).toBe(result);
  expect(await compressImage(result)).toBe(result);
  expect(workers).toHaveLength(1);
  expect(workers[0].terminate).toHaveBeenCalledOnce();
});

it('keeps smaller original bytes with normalized extension and MIME', async () => {
  reply.bytes = new Uint8Array([...new Uint8Array(webp()), ...new Uint8Array(100)]).buffer;
  const original = png();
  const result = await compressImage(new File([original], 'logo.jpg', { type: 'image/jpeg' }));
  expect(result.name).toBe('logo.png');
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(original);
});

it('preserves animation without flattening or starting a worker', async () => {
  const original = png();
  const view = new DataView(original.buffer);
  view.setUint32(8, 13);
  original.set(new TextEncoder().encode('IHDR'), 12);
  view.setUint32(33, 8);
  original.set(new TextEncoder().encode('acTL'), 37);
  const result = await compressImage(new File([original], 'animated.apng'));
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(original);
  expect(result.name).toBe('animated.png');
  expect(workers).toHaveLength(0);
});

it('rejects unsafe dimensions and input bytes before decoding', async () => {
  for (const file of [
    new File([png(100, 8001, 1)], 'large.png'),
    new File([png(100, 8000, 8000)], 'large.png'),
    new File(['no'], 'fake.png'),
    new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.png'),
  ])
    await expect(compressImage(file)).rejects.toThrow();
  expect(workers).toHaveLength(0);
});

it('rejects mismatched encoded dimensions and releases the worker', async () => {
  reply = { bytes: webp(1, 1), width: 2, height: 3 };
  await expect(compressImage(new File([png()], 'image.png'))).rejects.toThrow('dimensions');
  expect(workers[0].terminate).toHaveBeenCalledOnce();
});

it('rejects output above the storage limit and permits retry after a codec failure', async () => {
  reply.error = 'Codec failed';
  const file = new File([png(6 * 1024 * 1024)], 'large.png');
  await expect(compressImage(file)).rejects.toThrow('Codec failed');
  delete reply.error;
  reply.bytes = new Uint8Array([
    ...new Uint8Array(webp()),
    ...new Uint8Array(6 * 1024 * 1024),
  ]).buffer;
  await expect(compressImage(file)).rejects.toThrow('5 MiB');
  expect(workers).toHaveLength(2);
  expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
});

it('terminates cancelled and timed-out workers', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  // Hold the worker response so cancellation and timeout are the only settlement paths.
  class HangingWorker extends FakeWorker {
    override postMessage = vi.fn();
  }
  vi.stubGlobal('Worker', HangingWorker);
  const first = compressImage(new File([png()], 'first.png'), controller.signal);
  const firstCheck = expect(first).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  controller.abort();
  await firstCheck;
  const second = compressImage(new File([png()], 'second.png'));
  const secondCheck = expect(second).rejects.toThrow('timed out');
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  await vi.advanceTimersByTimeAsync(60_000);
  await secondCheck;
  expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
});
