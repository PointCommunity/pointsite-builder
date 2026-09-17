import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../src/client/api';
import { PublicationVerification } from '../../src/client/publish/PublicationVerification';
import type { PublicationVerificationState } from '../../src/client/publish/workflow';

const pending: PublicationVerificationState = {
  id: 'verification',
  status: 'running',
  attempt: 1,
  dispatchAttempts: 2,
  retryAt: new Date().toISOString(),
  requestedAt: new Date().toISOString(),
  reported: false,
  needsAttention: false,
  workflowUrl: 'https://github.com/PointCommunity/pointsite/actions/runs/123',
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('discards an old publication read after switching jobs', async () => {
  let finishOld!: (value: Awaited<ReturnType<typeof api.getPublicationVerification>>) => void;
  vi.spyOn(api, 'getPublicationVerification')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValue({ verification: pending });
  const refresh = async () => {};
  const view = render(
    <PublicationVerification
      key="old"
      target="staging"
      jobId="old"
      dispatchAttempts={1}
      onRefresh={refresh}
    />,
  );
  view.rerender(
    <PublicationVerification
      key="new"
      target="staging"
      jobId="new"
      dispatchAttempts={2}
      onRefresh={refresh}
    />,
  );
  await screen.findByText('Verification is checking the existing publication.');
  await act(async () => {
    finishOld({ verification: null });
    await Promise.resolve();
  });
  expect(screen.queryByRole('button', { name: 'Verify existing publication' })).toBeNull();
  expect(screen.getByText('Verification is checking the existing publication.')).toBeVisible();
});

it('keeps capture identity after a lost reply and returns keyboard focus', async () => {
  vi.spyOn(api, 'getPublicationVerification').mockResolvedValue({ verification: null });
  const capture = vi
    .spyOn(api, 'capturePublicationVerification')
    .mockRejectedValueOnce(new Error('private provider detail'))
    .mockResolvedValue({ recovered: true, verificationId: 'verification' });
  render(
    <PublicationVerification
      target="staging"
      jobId="job"
      dispatchAttempts={6}
      onRefresh={async () => {}}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Verify existing publication' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Verify existing publication' })).toBeEnabled(),
  );
  expect(screen.getByRole('heading', { name: 'Staging verification' })).toHaveFocus();
  expect(screen.queryByText(/private provider detail/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Verify existing publication' }));
  await waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
  expect(capture.mock.calls[0]).toEqual(['staging', 'job', 6, expect.any(String)]);
  expect(capture.mock.calls[1]).toEqual(capture.mock.calls[0]);
});

it('reopens a saved report and reconciles it without starting another verification', async () => {
  vi.spyOn(api, 'getPublicationVerification').mockResolvedValue({
    verification: { ...pending, reported: true },
  });
  const recover = vi
    .spyOn(api, 'recoverPublicationVerification')
    .mockResolvedValue({ recovered: true });
  const capture = vi.spyOn(api, 'capturePublicationVerification');
  const refresh = vi.fn(() => {
    screen.getByRole('heading', { name: 'Production' }).focus();
    return Promise.resolve();
  });
  render(
    <>
      <h2 tabIndex={-1}>Production</h2>
      <PublicationVerification
        target="production"
        jobId="job"
        dispatchAttempts={6}
        onRefresh={refresh}
      />
    </>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Finish verification' }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(recover).toHaveBeenCalledWith(
    'production',
    'job',
    'verification',
    'reconcile',
    2,
    expect.any(String),
  );
  expect(capture).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Finish verification' })).toBeEnabled(),
  );
  expect(screen.getByRole('heading', { name: 'Production' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Retry stopped verification' })).toBeNull();
});

it('continues monitoring while preventing a fourth recovery attempt', async () => {
  vi.useFakeTimers();
  const row = {
    ...pending,
    attempt: 3,
    requestedAt: new Date(Date.now() - 15 * 60_000 + 10_000).toISOString(),
  };
  const read = vi
    .spyOn(api, 'getPublicationVerification')
    .mockImplementation(() => Promise.resolve({ verification: { ...row } }));
  render(
    <PublicationVerification
      target="staging"
      jobId="job"
      dispatchAttempts={6}
      onRefresh={async () => {}}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(read).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('button', { name: 'Retry stopped verification' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check verification status' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(read).toHaveBeenCalledTimes(4);
});
