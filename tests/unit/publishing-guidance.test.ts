import { describe, expect, it } from 'vitest';
import {
  describeFailedCheck,
  getActionFailureGuidance,
  getPublishingNextStep,
} from '../../src/client/publish/guidance';
import type { StagingWorkflowPhase, StagingWorkflowView } from '../../src/client/publish/workflow';

const lifecycle = (
  phase: StagingWorkflowPhase,
  step: StagingWorkflowView['step'],
): StagingWorkflowView => ({
  phase,
  step,
  title: phase,
  guidance: phase,
  canPublish: ['ready', 'stale'].includes(phase) || (phase === 'failed' && step === 2),
  canRefresh: phase !== 'loading',
  canAccept: phase === 'review-ready',
  shouldPoll: ['publishing', 'verifying'].includes(phase),
});

describe('non-technical publishing guidance', () => {
  it.each([
    ['loading', 1, null],
    ['unavailable', 1, 'Try loading again'],
    ['ready', 1, 'Publish revision 76 to Staging'],
    ['publishing', 2, null],
    ['verifying', 3, null],
    ['paused', 3, 'Continue verification'],
    ['review-ready', 4, 'Open Staging for review'],
    ['accepted', 5, null],
    ['failed', 2, 'Try publishing again'],
    ['failed', 3, 'Open failed checks'],
    ['stale', 1, 'Publish current revision 76'],
  ] as const)(
    'defines the action decision and effect for the %s state at step %s',
    (phase, step, primaryAction) => {
      const guidance = getPublishingNextStep(lifecycle(phase, step), 'publisher', 76);
      expect(guidance.primaryAction).toBe(primaryAction);
      expect(guidance.title.length).toBeGreaterThan(5);
      expect(guidance.guidance.length).toBeGreaterThan(12);
      expect(guidance.effect.length).toBeGreaterThan(12);
    },
  );

  it('explains the Administrator completion boundary without inventing Production access', () => {
    const guidance = getPublishingNextStep(lifecycle('accepted', 5), 'administrator', 76);
    expect(guidance.primaryAction).toBeNull();
    expect(guidance.title).toBe('Your Staging work is complete');
    expect(guidance.guidance).toMatch(/No Production action is available/i);
    expect(guidance.effect).toMatch(/Production is unchanged/i);
  });

  it.each([
    ['verify', 'Website safety checks', /could not prove/i],
    ['deploy', 'Staging update', /Automatic recovery could not confirm/i],
    ['custom-check', 'Required check: custom-check', /site maintainer/i],
  ])('translates the %s check without hiding its meaning', (check, label, explanation) => {
    const description = describeFailedCheck(check);
    expect(description.label).toBe(label);
    expect(description.explanation).toMatch(explanation);
  });

  it.each([
    ['FORBIDDEN', 'Your access changed', /Builder Administrator/i],
    ['RATE_LIMITED', 'Builder needs a moment', /same action again/i],
    ['DRAFT_REVISION_DRIFT', 'A newer saved version is available', /reopen Publish/i],
    ['STAGING_BASE_DRIFT', 'Staging changed', /load the latest status/i],
    ['STAGING_RENDERER_MISMATCH', 'Staging renderer needs to be synchronized', /draft is safe/i],
    ['IDEMPOTENCY_CONFLICT', 'Builder found an earlier action', /load the saved progress/i],
    ['APPROVAL_JOB_NOT_SUCCEEDED', 'Staging is not ready to accept', /failed checks/i],
    ['APPROVAL_EVIDENCE_INCOMPLETE', 'Staging is not ready to accept', /failed checks/i],
    ['APPROVAL_TUPLE_MISMATCH', 'The Staging version changed', /review the current version/i],
    [
      'VALIDATION_FAILED',
      'Builder could not verify the saved details',
      /close and reopen Publish/i,
    ],
    ['NOT_FOUND', 'The saved publishing job is unavailable', /load the current workflow/i],
    [
      'PUBLISHING_NOT_CONFIGURED',
      'Publishing setup needs administrator attention',
      /draft is safe/i,
    ],
    ['INTERNAL_ERROR', 'The publishing service needs attention', /support reference/i],
    ['REQUEST_FAILED', 'Builder could not complete that action', /try the same action once/i],
  ])('maps %s to a plain-language recovery', (code, title, guidance) => {
    const recovery = getActionFailureGuidance(code);
    expect(recovery.title).toBe(title);
    expect(recovery.guidance).toMatch(guidance);
  });
});
