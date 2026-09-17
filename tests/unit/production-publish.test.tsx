import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../src/client/api';
import { ProductionPublish } from '../../src/client/publish/ProductionPublish';
import type {
  ProductionWorkflowSnapshot,
  StagingAcceptanceSummary,
} from '../../src/client/publish/workflow';

const approval: StagingAcceptanceSummary = {
  id: 'acceptance',
  publishJobId: 'staging',
  decision: 'approved',
  createdAt: '2026-09-13T00:00:00Z',
  tuple: {
    publicationProtocol: 2,
    siteId: 'pointsite',
    revisionId: 'captured-revision',
    revisionChecksum: 'a'.repeat(64),
    candidateChecksum: 'b'.repeat(64),
    schemaVersion: 1,
    rendererVersion: '1.0.0',
    stagingBaseSha: 'c'.repeat(40),
    stagingCommitSha: 'd'.repeat(40),
    productionBaseSha: 'e'.repeat(40),
    workflowRevision: 'f'.repeat(40),
    artifactDigest: 'a'.repeat(64),
  },
};
const destination = { repository: 'pointsite' as const, origin: 'https://pointatx.org' };
const queued: ProductionWorkflowSnapshot = {
  enabled: true,
  destination,
  busy: true,
  job: {
    id: 'production',
    status: 'queued',
    revisionId: 'captured-revision',
    candidateChecksum: 'b'.repeat(64),
    stagingJobId: 'staging',
    approvalId: 'acceptance',
    artifactDigest: 'a'.repeat(64),
    baseSha: 'e'.repeat(40),
    commitSha: null,
    requestedAt: new Date().toISOString(),
    completedAt: null,
    evidence: {},
    dispatch: {
      attempts: 3,
      needsAttention: true,
      reserved: false,
      retryAt: '2026-09-13T00:00:00Z',
      workflowUrl: 'https://github.com/PointCommunity/pointsite/actions/runs/123',
    },
  },
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('names the public Canary destination on both publish and rollback controls', async () => {
  vi.spyOn(api, 'getProductionWorkflow').mockResolvedValue({
    enabled: true,
    busy: false,
    job: null,
    destination: { repository: 'pointsite-canary', origin: 'https://canary.pointatx.org' },
  });
  vi.spyOn(api, 'getRollback').mockResolvedValue({
    enabled: true,
    job: null,
    releases: [],
    publicationJobId: null,
  });
  render(<ProductionPublish draftId="draft" approval={approval} />);
  expect(await screen.findByRole('button', { name: 'Publish to Site Canary' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Publish to Site Canary' }));
  expect(screen.getByRole('link', { name: 'https://staging-canary.pointatx.org' })).toHaveAttribute(
    'target',
    '_blank',
  );
  expect(screen.getByRole('link', { name: 'https://canary.pointatx.org' })).toHaveAttribute(
    'href',
    'https://canary.pointatx.org',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByText('Danger zone'));
  expect(screen.getByRole('heading', { name: 'Restore a Site Canary release' })).toBeVisible();
  expect(screen.queryByText(/Site Production/)).toBeNull();
});

it('requires matching artifact evidence before describing a completed publication as verified', async () => {
  const completed = structuredClone(queued);
  if (!completed.enabled || !completed.job) throw new Error('fixture');
  completed.busy = false;
  completed.job.status = 'succeeded';
  completed.job.dispatch = undefined;
  completed.job.evidence = { verificationStatus: 'passed', artifactDigest: 'f'.repeat(64) };
  const verified = structuredClone(completed);
  verified.job!.evidence.artifactDigest = verified.job!.artifactDigest;
  vi.spyOn(api, 'getProductionWorkflow')
    .mockResolvedValueOnce(completed)
    .mockResolvedValue(verified);
  const publish = vi.spyOn(api, 'publishProduction');
  render(<ProductionPublish draftId="draft" approval={approval} />);
  expect(
    await screen.findByText('Publication needs attention. Check status or copy support details.'),
  ).toBeVisible();
  expect(screen.queryByText('Publication completed and verified.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check Site Production status' }));
  expect(await screen.findByText('Publication completed and verified.')).toBeVisible();
  expect(publish).not.toHaveBeenCalled();
});

it('fails closed for disabled, unreadable and occupied Production state', async () => {
  const read = vi.spyOn(api, 'getProductionWorkflow').mockResolvedValue({ enabled: false });
  const view = render(<ProductionPublish draftId="draft" approval={approval} />);
  expect(await screen.findByText(/Public site publishing is not enabled/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Publish to Site Production' })).toBeNull();
  view.unmount();
  read.mockRejectedValueOnce(new Error('private provider detail'));
  render(<ProductionPublish draftId="draft" approval={approval} />);
  expect(
    await screen.findByText(
      'Public site status is unavailable. Check status before taking another action.',
    ),
  ).toBeVisible();
  expect(screen.queryByText(/private provider detail/)).toBeNull();
  read.mockResolvedValue({ enabled: true, destination, busy: true, job: null });
  fireEvent.click(screen.getByRole('button', { name: 'Check Public site status' }));
  expect(
    await screen.findByText(/Another Site Production publication needs to finish/),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Publish to Site Production' })).toBeNull();
});

it('keeps exact acceptance and request identity after an uncertain capture reply', async () => {
  const read = vi
    .spyOn(api, 'getProductionWorkflow')
    .mockResolvedValue({ enabled: true, destination, busy: false, job: null });
  const publish = vi
    .spyOn(api, 'publishProduction')
    .mockRejectedValueOnce(new Error('lost reply'))
    .mockResolvedValueOnce({ id: 'production', status: 'queued' });
  render(<ProductionPublish draftId="draft" approval={approval} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Publish to Site Production' }));
  expect(publish).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm publish to Site Production' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Publish to Site Production' })).toBeEnabled(),
  );
  read.mockResolvedValue(queued);
  fireEvent.click(screen.getByRole('button', { name: 'Publish to Site Production' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm publish to Site Production' }));
  await screen.findByText(
    'Publication needs attention. Copy the support details if you need help.',
  );
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish.mock.calls[0]).toEqual([
    'staging',
    'acceptance',
    approval.tuple,
    expect.any(String),
  ]);
  expect(publish.mock.calls[1]).toEqual(publish.mock.calls[0]);
});

it('reopens saved progress and preserves recovery identity across lost replies', async () => {
  vi.spyOn(api, 'getProductionWorkflow').mockResolvedValue(queued);
  const recover = vi
    .spyOn(api, 'recoverProduction')
    .mockRejectedValueOnce(new Error('lost reply'))
    .mockResolvedValueOnce({ recovered: true });
  render(<ProductionPublish draftId="draft" approval={null} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry queued publication' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Retry queued publication' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry queued publication' }));
  await waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
  expect(recover.mock.calls[0]).toEqual(['production', 'retry', 3, expect.any(String)]);
  expect(recover.mock.calls[1]).toEqual(recover.mock.calls[0]);
});

it('monitors past fifteen minutes and stops on verified completion', async () => {
  vi.useFakeTimers();
  const active = structuredClone(queued);
  if (!active.enabled || !active.job || !active.job.dispatch) throw new Error('fixture');
  active.job.requestedAt = new Date(Date.now() - 30 * 60_000).toISOString();
  active.job.dispatch.needsAttention = false;
  const read = vi
    .spyOn(api, 'getProductionWorkflow')
    .mockImplementation(() => Promise.resolve(structuredClone(active)));
  render(<ProductionPublish draftId="draft" approval={approval} />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(read).toHaveBeenCalledTimes(2);
  active.busy = false;
  active.job.status = 'succeeded';
  active.job.evidence = { verificationStatus: 'passed', artifactDigest: active.job.artifactDigest };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(screen.getByRole('heading', { name: /Congratulations/ })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Open Site Production' })).toHaveAttribute(
    'href',
    destination.origin,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(read).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
});

it('cancels confirmation and prevents publishing a changed acceptance or newer draft', async () => {
  vi.spyOn(api, 'getProductionWorkflow').mockResolvedValue({
    enabled: true,
    destination,
    busy: false,
    job: null,
  });
  const publish = vi.spyOn(api, 'publishProduction');
  const view = render(<ProductionPublish draftId="draft" approval={approval} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Publish to Site Production' }));
  let dialog = screen.getByRole('dialog', { name: 'Publish to Site Production?' });
  expect(
    within(dialog).getByRole('link', { name: 'https://staging.pointatx.org' }),
  ).toHaveAttribute('target', '_blank');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(publish).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Publish to Site Production' }));
  view.rerender(
    <ProductionPublish draftId="draft" approval={{ ...approval, id: 'new-acceptance' }} />,
  );
  dialog = screen.getByRole('dialog');
  expect(
    within(dialog).getByRole('button', { name: 'Confirm publish to Site Production' }),
  ).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  view.rerender(<ProductionPublish draftId="draft" approval={approval} stagingReady={false} />);
  expect(screen.queryByRole('button', { name: 'Publish to Site Production' })).toBeNull();
  expect(publish).not.toHaveBeenCalled();
});
