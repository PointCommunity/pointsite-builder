export type PublishJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type VerificationStatus = 'pending' | 'passed' | 'failed';

export interface StagingWorkflowJob {
  id: string;
  publicationProtocol?: 2;
  workflowRevision?: string;
  dispatch?: {
    attempts: number;
    retryAt: string;
    needsAttention: boolean;
    failureCode?: string;
    workflowUrl?: string;
  };
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
    failedCheckUrls?: Record<string, string>;
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
  preflight:
    | {
        state: 'passed';
        revisionId: string;
        revisionChecksum: string;
        candidateChecksum: string;
        validatedAt: string;
      }
    | {
        state: 'required';
        reason: 'not-validated' | 'revision-changed' | 'renderer-contract-changed' | 'failed';
      };
  availability:
    | { state: 'available' }
    | { state: 'busy'; phase: 'queued' | 'running' | 'review' | 'recovery'; retryAt?: string };
  job: StagingWorkflowJob | null;
  approval: StagingAcceptanceSummary | null;
}

export type StagingWorkflowPhase =
  | 'loading'
  | 'unavailable'
  | 'ready'
  | 'waiting'
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

  const { job, approval, currentStagingSha, preflight, availability } = input.snapshot;

  const revisionChanged =
    Boolean(job) &&
    (job!.revisionId !== input.revisionId || job!.revisionChecksum !== input.revisionChecksum);
  const stagingChanged = Boolean(
    job && job.stagingCommitSha && currentStagingSha !== job.stagingCommitSha,
  );

  const captured = job?.publicationProtocol === 2;
  if (captured && job.dispatch?.needsAttention)
    return state(
      'paused',
      2,
      'Publication needs attention',
      'Automatic dispatch retries stopped. Your captured version is saved. Ask a site maintainer to reconcile this job before trying again.',
      { canRefresh: true },
    );
  if (
    (!revisionChanged || captured) &&
    job &&
    (job.status === 'queued' || job.status === 'running')
  ) {
    if (captured && input.monitoringPaused)
      return state(
        'paused',
        2,
        'Automatic monitoring paused',
        'Your captured publication continues in the cloud. Check status to read its latest progress.',
        { canRefresh: true },
      );
    return state(
      'publishing',
      2,
      'Publishing to protected Staging',
      captured
        ? revisionChanged
          ? 'The captured version continues in the cloud. Your newer saved edits are separate from this publication.'
          : 'The captured version continues in the cloud, even after you close Builder.'
        : 'The exact candidate is being created. This workflow will continue automatically.',
      { canRefresh: true, shouldPoll: true },
    );
  }
  const completedCurrentJob =
    (!revisionChanged || captured) && !stagingChanged && job?.status === 'succeeded';
  const preflightPassed =
    preflight.state === 'passed' &&
    preflight.revisionId === input.revisionId &&
    preflight.revisionChecksum === input.revisionChecksum;

  if (!completedCurrentJob && !preflightPassed)
    return state(
      'ready',
      1,
      'Private preflight required',
      preflight.state === 'required' && preflight.reason === 'failed'
        ? 'The last private check did not pass. Check this exact saved revision again before publishing.'
        : 'Check this exact saved revision privately before anything changes on Staging.',
      { canPublish: true },
    );

  if (!completedCurrentJob && availability.state === 'busy')
    return state(
      'waiting',
      2,
      'Staging is currently in use',
      'Your selected draft and private preflight remain safe. Builder will check availability without queuing or interrupting the active publication.',
      { canRefresh: true, shouldPoll: true },
    );

  if (!job || (revisionChanged && !captured))
    return state(
      'ready',
      2,
      'Ready to publish',
      'Private preflight passed for this exact saved revision. Publishing can now claim the shared Staging slot.',
      { canPublish: true, canRefresh: true },
    );

  if (stagingChanged)
    return state(
      'stale',
      2,
      'No longer current on Staging',
      'Another accepted or published candidate is now current. This draft and its history remain safe and can be published again.',
      { canPublish: true, canRefresh: true },
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
      'Acceptance remains locked. Use the recovery steps above; checking again only reads the latest result.',
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
      captured
        ? 'The cloud build, deployment identity, and live file checks are running.'
        : 'Build, deployment, live routes, accessibility, responsive behavior, and security checks are running.',
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
