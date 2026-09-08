import type { StagingWorkflowView } from './workflow';

export type PublishingRole = 'publisher' | 'administrator';

export interface PublishingNextStep {
  title: string;
  guidance: string;
  effect: string;
  primaryAction: string | null;
}

export interface ActionFailureGuidance {
  title: string;
  guidance: string;
}

export function getPublishingNextStep(
  lifecycle: StagingWorkflowView,
  role: PublishingRole,
  revision: number,
): PublishingNextStep {
  switch (lifecycle.phase) {
    case 'loading':
      return {
        title: 'Loading your next step',
        guidance: 'No action is needed while Builder recovers the latest saved progress.',
        effect: 'Builder is only reading saved progress. It will not change Staging or Production.',
        primaryAction: null,
      };
    case 'unavailable':
      return {
        title: 'Try loading the workflow again',
        guidance: 'Builder could not load the saved publishing status. Your content is unchanged.',
        effect: 'Trying again only reloads status. It does not publish anything.',
        primaryAction: 'Try loading again',
      };
    case 'ready':
      return {
        title: `Publish revision ${revision} to Staging`,
        guidance: 'This saved revision is ready for the protected Staging website.',
        effect: 'Publishing creates one Staging candidate. It does not change Production.',
        primaryAction: `Publish revision ${revision} to Staging`,
      };
    case 'publishing':
      return {
        title: 'No action needed — publishing is underway',
        guidance: 'Builder is creating the protected Staging version and will keep checking it.',
        effect: 'You may close this window and return later. Your progress is saved.',
        primaryAction: null,
      };
    case 'verifying':
      return {
        title: 'No action needed — Builder is verifying Staging',
        guidance: 'Builder will advance automatically when every required check finishes.',
        effect: 'Checking progress does not publish again and never changes Production.',
        primaryAction: null,
      };
    case 'paused':
      return {
        title: 'Continue verification',
        guidance: 'Select the button below to check this exact Staging version now.',
        effect: 'This checks the existing Staging version only. It does not publish again.',
        primaryAction: 'Continue verification',
      };
    case 'review-ready':
      return {
        title: 'Review Staging, then accept this version',
        guidance: 'Complete the two actions below in order.',
        effect: 'Acceptance records this exact Staging version. Production remains unchanged.',
        primaryAction: 'Open Staging for review',
      };
    case 'accepted':
      return {
        title: 'Your Staging work is complete',
        guidance:
          role === 'administrator'
            ? 'No Production action is available here yet. Production publishing remains protected and disabled until its separate setup and approval are complete.'
            : 'No more publishing action is required from you. This exact version is now the official Staging candidate.',
        effect:
          role === 'administrator'
            ? 'The accepted Staging version is recorded. Production is unchanged.'
            : 'The accepted Staging version is recorded. The public site was not changed.',
        primaryAction: null,
      };
    case 'failed':
      return lifecycle.step === 2
        ? {
            title: 'Try publishing this revision again',
            guidance: 'The earlier attempt stopped before the Staging candidate was completed.',
            effect:
              'Retrying uses this exact saved revision. If it fails again, a site maintainer must investigate; Production remains unchanged.',
            primaryAction: 'Try publishing again',
          }
        : {
            title: 'Resolve the failed Staging checks',
            guidance:
              'At least one required check needs attention before this version can be accepted.',
            effect:
              'Checking here only reads the latest result. It does not rerun a failed check or change Production.',
            primaryAction: 'Open failed checks',
          };
    case 'stale':
      return {
        title: `Publish the current revision ${revision}`,
        guidance: 'The earlier candidate is no longer current and cannot be accepted.',
        effect: 'Publishing creates a new Staging candidate from the latest saved version.',
        primaryAction: `Publish current revision ${revision}`,
      };
  }
}

export function describeFailedCheck(check: string): { label: string; explanation: string } {
  if (check === 'verify')
    return {
      label: 'Website safety checks',
      explanation: 'The candidate could not prove that the website builds and works safely.',
    };
  if (check === 'deploy')
    return {
      label: 'Staging update',
      explanation: 'The protected Staging website did not finish updating.',
    };
  const safeName = check.trim().slice(0, 80) || 'unknown';
  return {
    label: `Required check: ${safeName}`,
    explanation: 'A site maintainer must review this required check before acceptance.',
  };
}

export function getActionFailureGuidance(code: string): ActionFailureGuidance {
  switch (code) {
    case 'FORBIDDEN':
    case 'UNAUTHENTICATED':
      return {
        title: 'Your access changed',
        guidance:
          'Sign in again. If the action is still unavailable, ask a Builder Administrator to check your Builder role and Staging repository access.',
      };
    case 'RATE_LIMITED':
      return {
        title: 'Builder needs a moment',
        guidance: 'Wait about a minute, then choose the same action again. Nothing was published.',
      };
    case 'DRAFT_REVISION_DRIFT':
    case 'REVISION_CONFLICT':
      return {
        title: 'A newer saved version is available',
        guidance: 'Close this window, confirm that all changes are saved, then reopen Publish.',
      };
    case 'STAGING_BASE_DRIFT':
    case 'STAGING_CANDIDATE_DRIFT':
      return {
        title: 'Staging changed',
        guidance:
          'Use the available check action to load the latest status. Builder will then offer the safe current revision if a new candidate is required.',
      };
    case 'STAGING_RENDERER_MISMATCH':
      return {
        title: 'Staging renderer needs to be synchronized',
        guidance:
          'Your draft is safe and no candidate was published. Ask a site maintainer to synchronize the protected Staging renderer with Builder, then try again.',
      };
    case 'IDEMPOTENCY_CONFLICT':
      return {
        title: 'Builder found an earlier action',
        guidance:
          'Use the available check action to load the saved progress. Do not submit a duplicate publish or acceptance.',
      };
    case 'APPROVAL_JOB_NOT_SUCCEEDED':
    case 'APPROVAL_EVIDENCE_INCOMPLETE':
      return {
        title: 'Staging is not ready to accept',
        guidance:
          'Return to the failed checks shown in this workflow. Resolve them before trying to accept this version again.',
      };
    case 'APPROVAL_TUPLE_MISMATCH':
      return {
        title: 'The Staging version changed',
        guidance:
          'Load the latest workflow, open and review the current version, then accept only the version now shown.',
      };
    case 'VALIDATION_FAILED':
      return {
        title: 'Builder could not verify the saved details',
        guidance:
          'Close and reopen Publish to reload the saved revision. If this returns, give the support reference below to a site maintainer.',
      };
    case 'NOT_FOUND':
      return {
        title: 'The saved publishing job is unavailable',
        guidance:
          'Close and reopen Publish to load the current workflow. Builder will show whether a new Staging candidate is needed.',
      };
    case 'PUBLISHING_NOT_CONFIGURED':
    case 'APPROVALS_NOT_CONFIGURED':
    case 'PRODUCTION_BASE_UNAVAILABLE':
    case 'STAGING_BASE_UNAVAILABLE':
      return {
        title: 'Publishing setup needs administrator attention',
        guidance:
          'Your draft is safe. Ask a Builder Administrator or site maintainer to restore the publishing connection, then try again.',
      };
    case 'PUBLISH_IN_PROGRESS':
    case 'PUBLISH_JOB_NOT_VERIFIABLE':
      return {
        title: 'This workflow is still catching up',
        guidance:
          'Wait a moment, then check the same Staging version again. Do not publish a duplicate.',
      };
    case 'INTERNAL_ERROR':
      return {
        title: 'The publishing service needs attention',
        guidance:
          'Try once more. If it fails again, give the support reference below to a Builder Administrator or site maintainer. Your draft and Production are unchanged.',
      };
    default:
      return {
        title: 'Builder could not complete that action',
        guidance:
          'Nothing changed in Production. Try the same action once. If it fails again, ask a Builder Administrator or site maintainer for help.',
      };
  }
}
