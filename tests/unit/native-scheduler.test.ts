// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { startScheduler } from '../../server/scheduler';

test('background work cannot overlap and shutdown drains only its own pending work', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const scheduler = startScheduler(run, 1_000);
  try {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    const stopping = scheduler.stop();
    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    finish();
    await scheduler.stop();
    vi.useRealTimers();
  }
});

test('a failed dispatch is sanitized and the next scheduled attempt remains available', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const run = vi
    .fn()
    .mockRejectedValueOnce(new Error('private provider details'))
    .mockResolvedValue(undefined);
  const scheduler = startScheduler(run, 1_000);
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledExactlyOnceWith('{"event":"maintenance_incomplete"}');
  } finally {
    await scheduler.stop();
    log.mockRestore();
    vi.useRealTimers();
  }
});
