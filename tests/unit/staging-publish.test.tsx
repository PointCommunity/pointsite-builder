import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ClientApiError } from '../../src/client/api';
import { EditorProvider } from '../../src/client/editor/EditorProvider';
import { StagingPublish } from '../../src/client/publish/StagingPublish';
import type { StagingWorkflowSnapshot } from '../../src/client/publish/workflow';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftRecord, Role } from '../../src/server/repositories/contracts';

const document = structuredClone(defaultSiteDocument);
const draft: DraftRecord = {
  id: '10000000-0000-4000-8000-000000000001',
  siteId: 'pointsite',
  name: 'Publishing test',
  status: 'active',
  latestRevisionId: '20000000-0000-4000-8000-000000000001',
  document,
  revision: {
    id: '20000000-0000-4000-8000-000000000001',
    draftId: '10000000-0000-4000-8000-000000000001',
    sequence: 3,
    parentRevisionId: null,
    checksum: 'a'.repeat(64),
    document,
    label: null,
    schemaVersion: document.schemaVersion,
    rendererVersion: document.rendererVersion,
    createdBy: 'publisher@pointatx.org',
    createdAt: '2026-09-07T12:00:00Z',
    actionCategory: 'text-edit',
    actionContext: 'page-content',
  },
  createdBy: 'publisher@pointatx.org',
  createdAt: '2026-09-07T12:00:00Z',
  updatedAt: '2026-09-07T12:00:00Z',
  deletedAt: null,
};

const job = {
  id: '30000000-0000-4000-8000-000000000001',
  status: 'succeeded' as const,
  candidateChecksum: 'b'.repeat(64),
  draftId: draft.id,
  revisionId: draft.revision.id,
  revisionChecksum: draft.revision.checksum,
  schemaVersion: document.schemaVersion,
  rendererVersion: document.rendererVersion,
  stagingBaseSha: 'c'.repeat(40),
  stagingCommitSha: 'd'.repeat(40),
  commitUrl: `https://github.com/PointCommunity/pointsite-staging/commit/${'d'.repeat(40)}`,
  requestedAt: '2026-09-07T12:01:00Z',
  completedAt: '2026-09-07T12:02:00Z',
  evidence: { verificationStatus: 'pending' as const },
};

const ready: StagingWorkflowSnapshot = {
  currentStagingSha: 'c'.repeat(40),
  reviewUrl: 'https://staging.pointatx.org',
  preflight: {
    state: 'passed',
    revisionId: draft.revision.id,
    revisionChecksum: draft.revision.checksum,
    candidateChecksum: job.candidateChecksum,
    validatedAt: '2026-09-07T12:00:00Z',
  },
  availability: { state: 'available' },
  job: null,
  approval: null,
};
const verifying: StagingWorkflowSnapshot = {
  currentStagingSha: job.stagingCommitSha,
  reviewUrl: ready.reviewUrl,
  preflight: ready.preflight,
  availability: ready.availability,
  job,
  approval: null,
};
const needsPreflight: StagingWorkflowSnapshot = {
  ...ready,
  preflight: { state: 'required', reason: 'not-validated' },
};
const waiting: StagingWorkflowSnapshot = {
  ...ready,
  availability: {
    state: 'busy',
    phase: 'running',
    retryAt: '2026-09-07T12:15:00Z',
  },
};
const reviewReady: StagingWorkflowSnapshot = {
  ...verifying,
  job: { ...job, evidence: { verificationStatus: 'passed' as const } },
};
const accepted: StagingWorkflowSnapshot = {
  ...reviewReady,
  approval: {
    id: '40000000-0000-4000-8000-000000000001',
    publishJobId: job.id,
    decision: 'approved',
    createdAt: '2026-09-07T12:03:00Z',
  },
};

const verificationFailed: StagingWorkflowSnapshot = {
  ...verifying,
  job: {
    ...job,
    evidence: {
      verificationStatus: 'failed' as const,
      failedChecks: ['verify', 'deploy'],
      failedCheckUrls: {
        verify: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/11',
        deploy: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/12',
      },
    },
  },
};

const published = {
  jobId: job.id,
  siteId: 'pointsite' as const,
  revisionId: job.revisionId,
  revisionChecksum: job.revisionChecksum,
  schemaVersion: job.schemaVersion,
  rendererVersion: job.rendererVersion,
  candidateChecksum: job.candidateChecksum,
  stagingBaseSha: job.stagingBaseSha,
  commitSha: job.stagingCommitSha,
  url: job.commitUrl,
};

const renderPublish = (role: Extract<Role, 'publisher' | 'administrator'> = 'publisher') =>
  render(
    <EditorProvider initialDraft={draft}>
      <StagingPublish role={role} />
    </EditorProvider>,
  );

const queuedCloud: StagingWorkflowSnapshot = {
  ...ready,
  availability: { state: 'busy', phase: 'running' },
  job: {
    ...job,
    publicationProtocol: 2,
    status: 'queued',
    completedAt: null,
    stagingCommitSha: null,
    commitUrl: null,
    dispatch: {
      attempts: 6,
      retryAt: '2026-09-07T12:00:00Z',
      needsAttention: true,
      reserved: false,
    },
  },
};

describe('guided Staging publishing', () => {
  it('keeps check and cancel visible during polling and preserves a queued job after a read failure', async () => {
    const captured: StagingWorkflowSnapshot = {
      ...ready,
      publicationProtocol: 2,
      availability: { state: 'busy', phase: 'queued' },
      job: {
        ...job,
        status: 'queued',
        publicationProtocol: 2,
        stagingCommitSha: null,
        dispatch: {
          attempts: 1,
          retryAt: '',
          needsAttention: false,
          reserved: false,
          startUnconfirmed: true,
        },
      },
    };
    const read = vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(captured);
    const publish = vi.spyOn(api, 'publishStaging');
    renderPublish();
    const check = await screen.findByRole('button', { name: 'Check Staging status' });
    expect(screen.getByRole('button', { name: 'Cancel queued publication' })).toBeVisible();
    expect(screen.getByText('Start not confirmed')).toBeVisible();
    expect(screen.queryByRole('progressbar')).toBeNull();
    read.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(check);
    await screen.findByText('Status check unavailable');
    expect(screen.getByRole('button', { name: 'Cancel queued publication' })).toBeDisabled();
    expect(screen.getByText(/Showing the last known publication/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Check Staging status' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel queued publication' })).toBeEnabled(),
    );
    expect(publish).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'getProductionWorkflow').mockResolvedValue({ enabled: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reuses a recovery receipt after a lost response and refreshes durable status', async () => {
    const load = vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(queuedCloud);
    const recover = vi
      .spyOn(api, 'recoverQueuedPublication')
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValue({ recovered: true });
    renderPublish();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry queued publication' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry queued publication' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry queued publication' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover.mock.calls[0]).toEqual([job.id, 'retry', 6, expect.any(String)]);
    expect(recover.mock.calls[1]).toEqual(recover.mock.calls[0]);
  });

  it('retries the selected capture with a stable receipt instead of publishing the latest editor revision', async () => {
    const cancelled: StagingWorkflowSnapshot = {
      ...ready,
      job: {
        ...queuedCloud.job!,
        status: 'cancelled',
        revisionId: '20000000-0000-4000-8000-000000000002',
        dispatch: { ...queuedCloud.job!.dispatch!, canRetryCaptured: true },
      },
    };
    const load = vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(cancelled);
    const publish = vi.spyOn(api, 'publishStaging');
    const recover = vi
      .spyOn(api, 'recoverQueuedPublication')
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValue({ recovered: true, jobId: '30000000-0000-4000-8000-000000000002' });
    renderPublish();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry captured candidate' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry captured candidate' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry captured candidate' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(recover.mock.calls[0]).toEqual([job.id, 'retry-captured', 6, expect.any(String)]);
    expect(recover.mock.calls[1]).toEqual(recover.mock.calls[0]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('verifies a reported deployment and restores focus without publishing again', async () => {
    const reported: StagingWorkflowSnapshot = {
      ...queuedCloud,
      job: {
        ...queuedCloud.job!,
        status: 'running',
        dispatch: { ...queuedCloud.job!.dispatch!, reserved: true, canVerifyCompleted: true },
      },
    };
    vi.spyOn(api, 'getStagingWorkflow')
      .mockResolvedValueOnce(reported)
      .mockResolvedValue(reviewReady);
    const recover = vi
      .spyOn(api, 'recoverQueuedPublication')
      .mockResolvedValue({ recovered: true });
    const publish = vi.spyOn(api, 'publishStaging');
    renderPublish();
    fireEvent.click(await screen.findByRole('button', { name: 'Verify completed deployment' }));
    await waitFor(() =>
      expect(recover).toHaveBeenCalledWith(job.id, 'verify-completed', 6, expect.any(String)),
    );
    expect(
      await screen.findByRole('heading', { name: 'Review Staging, then accept this version' }),
    ).toHaveFocus();
    expect(publish).not.toHaveBeenCalled();
  });

  it('offers an explicit native recovery check without claiming the cloud run stopped', async () => {
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue({
      ...queuedCloud,
      job: {
        ...queuedCloud.job!,
        status: 'running',
        dispatch: { ...queuedCloud.job!.dispatch!, reserved: true, canReconcileStopped: true },
      },
    });
    const recover = vi
      .spyOn(api, 'recoverQueuedPublication')
      .mockRejectedValue(
        new ClientApiError(
          409,
          'PUBLICATION_RUN_NOT_TERMINAL',
          'Native execution not terminal',
          'fixture',
        ),
      );
    renderPublish();
    fireEvent.click(await screen.findByRole('button', { name: 'Recover stopped publication' }));
    await waitFor(() =>
      expect(recover).toHaveBeenCalledWith(job.id, 'reconcile', 6, expect.any(String)),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cloud execution has not been confirmed stopped',
    );
    expect(screen.queryByRole('button', { name: 'Cancel queued publication' })).toBeNull();
  });

  it('cancels the queued job and can publish the same saved revision again', async () => {
    const cancelled: StagingWorkflowSnapshot = {
      ...ready,
      job: { ...queuedCloud.job!, status: 'cancelled' },
    };
    vi.spyOn(api, 'getStagingWorkflow')
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(queuedCloud)
      .mockResolvedValueOnce(cancelled)
      .mockResolvedValue(queuedCloud);
    const publish = vi.spyOn(api, 'publishStaging').mockResolvedValue(published);
    const recover = vi
      .spyOn(api, 'recoverQueuedPublication')
      .mockResolvedValue({ recovered: true });
    renderPublish();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish to Staging' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel queued publication' }));
    await waitFor(() =>
      expect(recover).toHaveBeenCalledWith(job.id, 'cancel', 6, expect.any(String)),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Publish to Staging' }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(publish.mock.calls[1].slice(0, 4)).toEqual(publish.mock.calls[0].slice(0, 4));
    expect(publish.mock.calls[1][4]).not.toBe(publish.mock.calls[0][4]);
  });

  it.each([true, undefined])(
    'hides queued recovery when native reservation is %s',
    async (reserved) => {
      vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue({
        ...queuedCloud,
        job: { ...queuedCloud.job!, dispatch: { ...queuedCloud.job!.dispatch!, reserved } },
      });
      renderPublish();
      await screen.findByRole('heading', { name: 'Staging needs attention' });
      expect(screen.queryByRole('button', { name: 'Retry queued publication' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Cancel queued publication' })).toBeNull();
    },
  );

  it('resumes an uploading job after reload through explicit POST continuation', async () => {
    const uploading: StagingWorkflowSnapshot = {
      ...ready,
      availability: {
        state: 'busy',
        phase: 'running',
        retryAt: new Date(Date.now() + 900_000).toISOString(),
      },
      job: {
        ...job,
        status: 'running',
        requestedAt: new Date().toISOString(),
        completedAt: null,
        stagingCommitSha: null,
        commitUrl: null,
      },
    };
    vi.spyOn(api, 'getStagingWorkflow')
      .mockResolvedValueOnce(uploading)
      .mockResolvedValue(verifying);
    const continuation = vi.spyOn(api, 'continueStagingPublication').mockResolvedValue(published);
    const publish = vi.spyOn(api, 'publishStaging');
    renderPublish();
    expect(await screen.findByText('Publishing to Staging')).toBeVisible();
    expect(continuation).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(continuation).toHaveBeenCalledWith(job.id);
    expect(publish).not.toHaveBeenCalled();
    expect(
      await screen.findByText('No action needed — Builder is verifying Staging'),
    ).toBeVisible();
  });

  it('polls a captured cloud job with GET only after reload and later edits', async () => {
    const cloud: StagingWorkflowSnapshot = {
      ...ready,
      availability: { state: 'busy', phase: 'running' },
      job: {
        ...job,
        publicationProtocol: 2,
        status: 'running',
        revisionId: 'different-captured-revision',
        requestedAt: new Date().toISOString(),
        completedAt: null,
        stagingCommitSha: null,
        commitUrl: null,
      },
    };
    const load = vi
      .spyOn(api, 'getStagingWorkflow')
      .mockImplementation(() => Promise.resolve(structuredClone(cloud)));
    const continueJob = vi.spyOn(api, 'continueStagingPublication');
    const verifyJob = vi.spyOn(api, 'refreshStagingVerification');
    const publish = vi.spyOn(api, 'publishStaging');
    renderPublish();
    expect(await screen.findByText(/Newer draft edits are not included/)).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(load).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(continueJob).not.toHaveBeenCalled();
    expect(verifyJob).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('accepts the original captured tuple after recovery advances main, then revokes it', async () => {
    const tuple = {
      siteId: 'pointsite' as const,
      revisionId: '20000000-0000-4000-8000-000000000099',
      revisionChecksum: job.revisionChecksum,
      schemaVersion: job.schemaVersion,
      rendererVersion: job.rendererVersion,
      candidateChecksum: job.candidateChecksum,
      stagingBaseSha: job.stagingBaseSha,
      stagingCommitSha: job.stagingCommitSha,
      productionBaseSha: 'e'.repeat(40),
      publicationProtocol: 2 as const,
      workflowRevision: 'f'.repeat(40),
      artifactDigest: '1'.repeat(64),
    };
    const cloud = {
      ...reviewReady,
      currentStagingSha: '9'.repeat(40),
      availability: { state: 'busy' as const, phase: 'review' as const },
      job: {
        ...reviewReady.job!,
        revisionId: tuple.revisionId,
        publicationProtocol: 2 as const,
        workflowRevision: tuple.workflowRevision,
        evidence: {
          verificationStatus: 'passed' as const,
          artifactDigest: tuple.artifactDigest,
          verification: { dispatchRevision: '9'.repeat(40) },
        },
      },
    };
    const acceptedCloud = { ...cloud, approval: { ...accepted.approval!, tuple } };
    vi.spyOn(api, 'getStagingWorkflow')
      .mockResolvedValueOnce(cloud)
      .mockResolvedValueOnce(acceptedCloud)
      .mockResolvedValue(cloud);
    vi.spyOn(api, 'productionBase').mockResolvedValue({ sha: tuple.productionBaseSha });
    const approve = vi
      .spyOn(api, 'acceptStaging')
      .mockResolvedValue({ id: acceptedCloud.approval.id, decision: 'approved', tuple });
    const revoke = vi
      .spyOn(api, 'revokeStaging')
      .mockResolvedValue({ id: crypto.randomUUID(), decision: 'revoked', tuple });
    renderPublish();
    expect(await screen.findByText('Newer draft edits are not included.')).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: 'Accept this Staging version' }));
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(
        job.id,
        tuple,
        'Protected Staging reviewed in Builder',
        null,
      ),
    );
    fireEvent.click(await screen.findByText('Danger zone'));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Staging acceptance' }));
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke acceptance' }));
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith(job.id, tuple, acceptedCloud.approval.id),
    );
  });

  it('runs private preflight and publication from one intentional action', async () => {
    const load = vi
      .spyOn(api, 'getStagingWorkflow')
      .mockResolvedValueOnce(needsPreflight)
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(verifying);
    const preflight = vi.spyOn(api, 'preflightStaging').mockResolvedValue(ready.preflight);
    const publish = vi.spyOn(api, 'publishStaging').mockResolvedValue(published);

    renderPublish();
    fireEvent.click(await screen.findByRole('button', { name: 'Publish to Staging' }));

    await waitFor(() =>
      expect(preflight).toHaveBeenCalledWith(draft.id, draft.revision.id, draft.revision.checksum),
    );
    expect(publish).toHaveBeenCalledWith(
      draft.id,
      draft.revision.id,
      draft.revision.checksum,
      ready.currentStagingSha,
      expect.any(String),
    );
    expect(load).toHaveBeenCalledTimes(3);
    expect(
      await screen.findByText('No action needed — Builder is verifying Staging'),
    ).toBeVisible();
  });

  it('checks an occupied slot without queuing or publishing another draft', async () => {
    const load = vi
      .spyOn(api, 'getStagingWorkflow')
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce(ready);
    const publish = vi.spyOn(api, 'publishStaging');
    const preflight = vi.spyOn(api, 'preflightStaging');
    renderPublish();
    expect(await screen.findByText(/Another publication is using Staging/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Publish to Staging' })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(load).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
  });

  it('shows the complete path, publishes the exact revision, and advances automatically', async () => {
    const load = vi
      .spyOn(api, 'getStagingWorkflow')
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(verifying)
      .mockResolvedValueOnce(reviewReady)
      .mockResolvedValueOnce(accepted);
    const publish = vi.spyOn(api, 'publishStaging').mockResolvedValue(published);
    const verify = vi.spyOn(api, 'refreshStagingVerification').mockResolvedValue({
      id: job.id,
      status: job.status,
      candidateChecksum: job.candidateChecksum,
      resultSha: job.stagingCommitSha,
      evidence: reviewReady.job!.evidence,
    });
    vi.spyOn(api, 'productionBase').mockResolvedValue({ sha: 'e'.repeat(40) });
    vi.spyOn(api, 'acceptStaging').mockResolvedValue({
      id: accepted.approval!.id,
      decision: 'approved',
      tuple: {
        siteId: 'pointsite',
        revisionId: job.revisionId,
        revisionChecksum: job.revisionChecksum,
        schemaVersion: job.schemaVersion,
        rendererVersion: job.rendererVersion,
        candidateChecksum: job.candidateChecksum,
        stagingBaseSha: job.stagingBaseSha,
        stagingCommitSha: job.stagingCommitSha,
        productionBaseSha: 'e'.repeat(40),
      },
    });

    renderPublish();
    expect(await screen.findByRole('button', { name: 'Publish to Staging' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Publish revision 3 to Staging' })).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Publish to Staging' }));
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        draft.id,
        draft.revision.id,
        draft.revision.checksum,
        ready.currentStagingSha,
        expect.any(String),
      ),
    );
    expect(
      await screen.findByText('No action needed — Builder is verifying Staging'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Publish to Staging' })).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(verify).toHaveBeenCalledWith(job.id));
    expect(await screen.findByText('Review Staging, then accept this version')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Staging for review' })).toHaveAttribute(
      'href',
      ready.reviewUrl,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Accept this Staging version' }));
    expect(await screen.findByText('Staging accepted')).toBeVisible();
    expect(screen.getByText(/An Administrator can now publish/)).toBeVisible();
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('offers review after verified recovery while retaining earlier Actions failures in support', async () => {
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue({
      ...reviewReady,
      job: {
        ...reviewReady.job!,
        dispatch: {
          attempts: 1,
          retryAt: job.requestedAt,
          needsAttention: false,
          reserved: true,
          actions: {
            checkedAt: job.completedAt,
            jobs: [
              {
                name: 'Publish',
                status: 'completed',
                conclusion: 'failure',
                workflowUrl: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/11',
                steps: [],
              },
            ],
          },
        },
      },
    });
    renderPublish();
    expect(
      await screen.findByRole('button', { name: 'Accept this Staging version' }),
    ).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Staging needs attention' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy support details' })).not.toBeVisible();
    fireEvent.click(screen.getByText('Technical details'));
    expect(screen.getByLabelText('Staging technical details')).toHaveTextContent(
      '"conclusion": "failure"',
    );
  });

  it('restores an accepted exact candidate without offering another publish', async () => {
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(accepted);
    const publish = vi.spyOn(api, 'publishStaging');
    renderPublish();
    expect(await screen.findByText('Staging accepted')).toBeVisible();
    expect(screen.queryByRole('button', { name: /publish this revision/i })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Staging accepted' })).toBeVisible();
    expect(screen.getByText(/An Administrator can now publish/)).toBeVisible();
    expect(publish).not.toHaveBeenCalled();
  });

  it('continues monitoring beyond fifteen minutes without another publication', async () => {
    vi.setSystemTime('2026-09-07T12:20:00Z');
    const read = vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(verifying);
    vi.spyOn(api, 'refreshStagingVerification').mockResolvedValue({
      id: job.id,
      status: job.status,
      candidateChecksum: job.candidateChecksum,
      resultSha: job.stagingCommitSha,
      evidence: job.evidence,
    });
    const publish = vi.spyOn(api, 'publishStaging');
    renderPublish();
    await screen.findByRole('heading', { name: 'No action needed — Builder is verifying Staging' });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(read).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });

  it('gives an Administrator an honest Production handoff without a fake action', async () => {
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(accepted);
    renderPublish('administrator');
    expect(await screen.findByRole('heading', { name: 'Staging accepted' })).toBeVisible();
    expect(await screen.findByText(/Public site publishing is not enabled/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /publish.*production/i })).toBeNull();
  });

  it('offers one visible copy action with all failed checks while details stay collapsed', async () => {
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(verificationFailed);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPublish('administrator');
    expect(await screen.findByRole('heading', { name: 'Staging needs attention' })).toBeVisible();
    const details = screen.getByText('Technical details').closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Staging needs attention' })).getByRole('button', {
        name: 'Copy support details',
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain(verificationFailed.job!.evidence.failedCheckUrls!.verify);
    expect(copied).toContain(verificationFailed.job!.evidence.failedCheckUrls!.deploy);
    expect(copied).toContain(job.id);
    expect(copied).not.toContain('Publishing test');
    expect(screen.queryByRole('button', { name: 'Accept this Staging version' })).toBeNull();
  });

  it('turns an action error into a recovery instruction and support reference', async () => {
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(verificationFailed);
    vi.spyOn(api, 'refreshStagingVerification').mockRejectedValue(
      new ClientApiError(403, 'FORBIDDEN', 'Technical permission response', 'request-123'),
    );
    renderPublish('publisher');

    fireEvent.click(await screen.findByRole('button', { name: 'Check Staging status' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your access changed');
    expect(alert).toHaveTextContent(/sign in again/i);
    expect(alert).toHaveTextContent(/Builder Administrator/i);
    fireEvent.click(screen.getByText('Technical details'));
    const details = screen.getByLabelText('Staging technical details');
    expect(details).toBeVisible();
    expect(details).toHaveTextContent('"requestId": "request-123"');
    expect(details).toHaveTextContent('"code": "FORBIDDEN"');
    expect(alert).not.toHaveTextContent('Technical permission response');
  });
  it('keeps a failed revocation visible while Staging remains accepted', async () => {
    const tuple = {
      publicationProtocol: 2 as const,
      siteId: 'pointsite' as const,
      revisionId: job.revisionId,
      revisionChecksum: job.revisionChecksum,
      candidateChecksum: job.candidateChecksum,
      schemaVersion: job.schemaVersion,
      rendererVersion: job.rendererVersion,
      stagingBaseSha: job.stagingBaseSha,
      stagingCommitSha: job.stagingCommitSha,
      productionBaseSha: 'e'.repeat(40),
      workflowRevision: 'f'.repeat(40),
      artifactDigest: '1'.repeat(64),
    };
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue({
      ...accepted,
      job: {
        ...accepted.job!,
        publicationProtocol: 2,
        workflowRevision: tuple.workflowRevision,
        evidence: { verificationStatus: 'passed', artifactDigest: tuple.artifactDigest },
      },
      approval: { ...accepted.approval!, tuple },
    });
    const revoke = vi
      .spyOn(api, 'revokeStaging')
      .mockRejectedValue(
        new ClientApiError(409, 'APPROVAL_STATE_CHANGED', 'State changed', 'request-revoke'),
      );
    renderPublish();
    await screen.findByRole('heading', { name: 'Staging accepted' });
    fireEvent.click(screen.getByText('Danger zone'));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Staging acceptance' }));
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Staging acceptance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke acceptance' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The Staging version changed');
    expect(screen.getByRole('heading', { name: 'Staging accepted' })).toBeVisible();
  });

  it('opens Help without publishing and returns to the concise workflow', async () => {
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(ready);
    const publish = vi.spyOn(api, 'publishStaging');
    renderPublish();
    await screen.findByRole('button', { name: 'Publish to Staging' });
    fireEvent.click(screen.getByRole('button', { name: 'Publishing help' }));
    const help = screen.getByRole('dialog', { name: 'Publishing help' });
    expect(within(help).getByText(/No second acceptance is needed/)).toBeVisible();
    fireEvent.click(within(help).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });
});
