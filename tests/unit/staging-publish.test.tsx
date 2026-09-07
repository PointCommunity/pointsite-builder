import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/client/api';
import { EditorProvider } from '../../src/client/editor/EditorProvider';
import { StagingPublish } from '../../src/client/publish/StagingPublish';
import type { StagingWorkflowSnapshot } from '../../src/client/publish/workflow';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftRecord } from '../../src/server/repositories/contracts';

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
  job: null,
  approval: null,
};
const verifying: StagingWorkflowSnapshot = {
  currentStagingSha: job.stagingCommitSha,
  reviewUrl: ready.reviewUrl,
  job,
  approval: null,
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

const renderPublish = () =>
  render(
    <EditorProvider initialDraft={draft}>
      <StagingPublish />
    </EditorProvider>,
  );

describe('guided Staging publishing', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    expect(await screen.findByText('Ready to publish')).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Publish this revision to Staging' }));
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        draft.id,
        draft.revision.id,
        draft.revision.checksum,
        ready.currentStagingSha,
      ),
    );
    expect(await screen.findByText('Verifying the exact Staging candidate')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Publish this revision to Staging' })).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(verify).toHaveBeenCalledWith(job.id));
    expect(await screen.findByText('Staging is ready for review')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Review protected Staging site' })).toHaveAttribute(
      'href',
      ready.reviewUrl,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'I reviewed Staging — accept this revision' }),
    );
    expect(await screen.findByText('Official Staging candidate accepted')).toBeVisible();
    expect(screen.getByText(/public website has not changed/i)).toBeVisible();
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('restores an accepted exact candidate without offering another publish', async () => {
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(accepted);
    const publish = vi.spyOn(api, 'publishStaging');
    renderPublish();
    expect(await screen.findByText('Official Staging candidate accepted')).toBeVisible();
    expect(screen.queryByRole('button', { name: /publish this revision/i })).toBeNull();
    expect(screen.getByText(/Production remains unchanged/i)).toBeVisible();
    expect(publish).not.toHaveBeenCalled();
  });
});
