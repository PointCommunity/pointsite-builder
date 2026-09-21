import { act, renderHook, waitFor, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePublicationStatus } from '../../src/client/publish/usePublicationStatus';
import { PublicationProgress } from '../../src/client/publish/PublicationProgress';

afterEach(() => vi.useRealTimers());

it('coalesces competing checks, preserves a known job on failure, then recovers manually', async () => {
  let resolve!: (value: { id: string }) => void;
  const read = vi.fn().mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const { result } = renderHook(() => usePublicationStatus('draft', read));
  let first!: Promise<unknown>;
  let second!: Promise<unknown>;
  act(() => {
    first = result.current.load(true);
    second = result.current.load(true);
  });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  expect(first).toBe(second);
  await act(async () => {
    resolve({ id: 'captured' });
    await first;
  });
  read.mockRejectedValueOnce(new Error('Network unavailable'));
  await act(async () => {
    await result.current.load();
  });
  expect(result.current.snapshot).toEqual({ id: 'captured' });
  expect(result.current.stale).toBe(true);
  expect(result.current.paused).toBe(true);
  read.mockResolvedValueOnce({ id: 'captured' });
  await act(async () => {
    await result.current.load(true);
  });
  expect(result.current.stale).toBe(false);
  expect(result.current.paused).toBe(false);
});

it('ignores a late response from another draft', async () => {
  let resolve!: (value: { id: string }) => void;
  const oldRead = () =>
    new Promise<{ id: string }>((r) => {
      resolve = r;
    });
  const newRead = () => Promise.resolve({ id: 'new' });
  const { result, rerender } = renderHook(({ scope, read }) => usePublicationStatus(scope, read), {
    initialProps: { scope: 'old', read: oldRead },
  });
  rerender({ scope: 'new', read: newRead });
  await waitFor(() => expect(result.current.snapshot).toEqual({ id: 'new' }));
  await act(async () => {
    resolve({ id: 'old' });
    await Promise.resolve();
  });
  expect(result.current.snapshot).toEqual({ id: 'new' });
});

it('bounds automatic monitoring without changing publication and permits a manual restart', async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue({ id: 'captured' });
  const { result } = renderHook(() => usePublicationStatus('draft', read));
  await act(async () => {
    await result.current.load();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await result.current.load();
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(result.current.paused).toBe(true);
  await act(async () => {
    await result.current.load(true);
  });
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(['startup_failure', 'failure', 'timed_out', 'cancelled'])(
  'shows zero-job %s without apparent progress',
  (conclusion) => {
    render(
      <PublicationProgress
        job={{
          status: 'queued',
          dispatch: {
            attempts: 1,
            retryAt: '',
            needsAttention: true,
            reserved: false,
            actions: {
              checkedAt: '2026-09-21T12:00:00Z',
              run: {
                status: 'completed',
                conclusion,
                workflowUrl: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/123',
              },
              jobs: [],
            },
          },
        }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      conclusion === 'cancelled' ? 'Publishing run cancelled' : 'Publishing run stopped',
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  },
);
