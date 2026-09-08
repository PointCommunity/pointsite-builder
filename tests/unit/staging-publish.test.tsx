import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByText('Your next step · Publisher')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Publish revision 3 to Staging' })).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Publish revision 3 to Staging' }));
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        draft.id,
        draft.revision.id,
        draft.revision.checksum,
        ready.currentStagingSha,
      ),
    );
    expect(await screen.findByText('Verifying the exact Staging candidate')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Publish revision 3 to Staging' })).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(verify).toHaveBeenCalledWith(job.id));
    expect(await screen.findByText('Staging is ready for review')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Staging for review' })).toHaveAttribute(
      'href',
      ready.reviewUrl,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Accept this Staging version' }));
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
    expect(screen.getByRole('heading', { name: 'Your Staging work is complete' })).toBeVisible();
    expect(screen.getByText(/No more publishing action is required from you/i)).toBeVisible();
    expect(screen.getByText(/Production remains unchanged/i)).toBeVisible();
    expect(publish).not.toHaveBeenCalled();
  });

  it('turns paused monitoring into one obvious action and explains its effect', async () => {
    vi.setSystemTime('2026-09-07T12:20:00Z');
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(verifying);
    renderPublish();

    expect(await screen.findByRole('heading', { name: 'Continue verification' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue verification' })).toBeEnabled();
    expect(
      screen.getByText(
        /This checks the existing Staging version only\. It does not publish again/i,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Refresh Staging status' })).toBeNull();
  });

  it('gives an Administrator an honest Production handoff without a fake action', async () => {
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(accepted);
    renderPublish('administrator');

    expect(await screen.findByText('Your next step · Administrator')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Your Staging work is complete' })).toBeVisible();
    expect(screen.getByText(/No Production action is available here yet/i)).toBeVisible();
    expect(screen.getByText(/organization owner.*Builder Administrator role/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /publish.*production/i })).toBeNull();
  });

  it('gives a non-technical user the complete failed-check recovery path', async () => {
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(verificationFailed);
    renderPublish('administrator');

    expect(
      await screen.findByRole('heading', { name: 'Review 2 failed Staging checks' }),
    ).toBeVisible();
    expect(screen.getByText('Website safety checks')).toBeVisible();
    expect(screen.getByText('Staging update')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open website safety check' })).toHaveAttribute(
      'href',
      verificationFailed.job!.evidence.failedCheckUrls!.verify,
    );
    expect(screen.getByRole('link', { name: 'Open Staging update check' })).toHaveAttribute(
      'href',
      verificationFailed.job!.evidence.failedCheckUrls!.deploy,
    );
    expect(screen.getByText(/Automatic recovery has already checked/i)).toBeVisible();
    expect(
      screen.getByText(/do not publish the draft again just to clear this message/i),
    ).toBeVisible();
    expect(screen.getByText(/site maintainer/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check Staging status again' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check verification again' })).toBeNull();
  });

  it('turns an action error into a recovery instruction and support reference', async () => {
    vi.spyOn(api, 'getStagingWorkflow').mockResolvedValue(verificationFailed);
    vi.spyOn(api, 'refreshStagingVerification').mockRejectedValue(
      new ClientApiError(403, 'FORBIDDEN', 'Technical permission response', 'request-123'),
    );
    renderPublish('publisher');

    fireEvent.click(await screen.findByRole('button', { name: 'Check Staging status again' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your access changed');
    expect(alert).toHaveTextContent(/sign in again/i);
    expect(alert).toHaveTextContent(/Builder Administrator/i);
    expect(alert).toHaveTextContent('request-123');
    expect(alert).toHaveTextContent('FORBIDDEN');
    expect(alert).not.toHaveTextContent('Technical permission response');
  });
});
