export type PublishJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type VerificationStatus = 'pending' | 'passed' | 'failed';

export interface StagingWorkflowJob {
  id: string;
  status: PublishJobStatus;
  candidateChecksum: string;
  draftId: string;
  revisionId: string;
  revisionChecksum: string;
  schemaVersion: number;
  rendererVersion: string;
  stagingBaseSha: string;
  stagingCommitSha: string | null;
  commitUrl: string | null;
  requestedAt: string;
  completedAt: string | null;
  evidence: {
    verificationStatus?: VerificationStatus;
    failureCode?: string;
    failedChecks?: string[];
    workflowUrl?: string;
    deploymentUrl?: string;
    checks?: Record<string, boolean>;
  };
}

export interface StagingAcceptanceSummary {
  id: string;
  publishJobId: string;
  decision: 'approved' | 'rejected' | 'revoked';
  createdAt: string;
}

export interface StagingWorkflowSnapshot {
  currentStagingSha: string;
  reviewUrl: string;
  job: StagingWorkflowJob | null;
  approval: StagingAcceptanceSummary | null;
}

export type StagingWorkflowPhase =
  | 'loading'
  | 'unavailable'
  | 'ready'
  | 'publishing'
  | 'verifying'
  | 'paused'
  | 'review-ready'
  | 'accepted'
  | 'failed'
  | 'stale';

export interface StagingWorkflowView {
  phase: StagingWorkflowPhase;
  step: 1 | 2 | 3 | 4 | 5;
  title: string;
  guidance: string;
  canPublish: boolean;
  canRefresh: boolean;
  canAccept: boolean;
  shouldPoll: boolean;
}

const state = (
  phase: StagingWorkflowPhase,
  step: StagingWorkflowView['step'],
  title: string,
  guidance: string,
  actions: Partial<
    Pick<StagingWorkflowView, 'canPublish' | 'canRefresh' | 'canAccept' | 'shouldPoll'>
  > = {},
): StagingWorkflowView => ({
  phase,
  step,
  title,
  guidance,
  canPublish: false,
  canRefresh: false,
  canAccept: false,
  shouldPoll: false,
  ...actions,
});

export function deriveStagingWorkflow(input: {
  revisionId: string;
  revisionChecksum: string;
  snapshot: StagingWorkflowSnapshot | null | undefined;
  monitoringPaused: boolean;
}): StagingWorkflowView {
  if (input.snapshot === undefined)
    return state('loading', 1, 'Loading Staging workflow', 'Recovering the latest saved progress.');
  if (input.snapshot === null)
    return state(
      'unavailable',
      1,
      'Staging status is unavailable',
      'Your draft and the public website are unchanged. Refresh the workflow to try again.',
      { canRefresh: true },
    );

  const { job, approval, currentStagingSha } = input.snapshot;
  if (!job)
    return state(
      'ready',
      1,
      'Ready to publish',
      'Publish this exact saved revision to begin the protected Staging workflow.',
      { canPublish: true },
    );

  const revisionChanged =
    job.revisionId !== input.revisionId || job.revisionChecksum !== input.revisionChecksum;
  const stagingChanged = Boolean(
    job.stagingCommitSha && currentStagingSha !== job.stagingCommitSha,
  );
  if (revisionChanged || stagingChanged)
    return state(
      'stale',
      1,
      'A new Staging candidate is required',
      revisionChanged
        ? 'The draft changed after this workflow began. Publish the current saved revision.'
        : 'Protected Staging changed after this candidate was created. Publish again from the current Staging version.',
      { canPublish: true, canRefresh: true },
    );

  if (job.status === 'queued' || job.status === 'running')
    return state(
      'publishing',
      2,
      'Publishing to protected Staging',
      'The exact candidate is being created. This workflow will continue automatically.',
      { canRefresh: true, shouldPoll: true },
    );

  if (job.status === 'failed' || job.status === 'cancelled')
    return state(
      'failed',
      2,
      'Publishing stopped safely',
      'Nothing reached Production. Retry this exact saved revision or refresh for newer status.',
      { canPublish: true, canRefresh: true },
    );

  const verification = job.evidence.verificationStatus;
  if (verification === 'failed')
    return state(
      'failed',
      3,
      'Staging verification failed',
      'Acceptance remains locked. Review the failed checks, rerun them, then refresh here.',
      { canRefresh: true },
    );

  if (verification !== 'passed') {
    if (input.monitoringPaused)
      return state(
        'paused',
        3,
        'Automatic monitoring paused',
        'The workflow is still saved. Refresh manually to continue checking this exact candidate.',
        { canRefresh: true },
      );
    return state(
      'verifying',
      3,
      'Verifying the exact Staging candidate',
      'Build, deployment, live routes, accessibility, responsive behavior, and security checks are running.',
      { canRefresh: true, shouldPoll: true },
    );
  }

  if (approval?.publishJobId === job.id && approval.decision === 'approved')
    return state(
      'accepted',
      5,
      'Official Staging candidate accepted',
      'This exact revision is accepted on Staging. The public website has not changed.',
      { canRefresh: true },
    );

  return state(
    'review-ready',
    4,
    'Staging is ready for review',
    'All mandatory evidence passed. Review the protected site, then deliberately accept this exact revision.',
    { canRefresh: true, canAccept: true },
  );
}
