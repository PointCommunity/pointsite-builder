import { describe, expect, it } from 'vitest';
import {
  deriveStagingWorkflow,
  type StagingWorkflowSnapshot,
} from '../../src/client/publish/workflow';

const revisionId = '20000000-0000-4000-8000-000000000001';
const revisionChecksum = 'a'.repeat(64);
const stagingCommitSha = 'c'.repeat(40);

const snapshot = (overrides: Partial<StagingWorkflowSnapshot> = {}): StagingWorkflowSnapshot => ({
  currentStagingSha: stagingCommitSha,
  reviewUrl: 'https://staging.pointatx.org',
  job: {
    id: '30000000-0000-4000-8000-000000000001',
    status: 'succeeded',
    candidateChecksum: 'b'.repeat(64),
    draftId: '10000000-0000-4000-8000-000000000001',
    revisionId,
    revisionChecksum,
    schemaVersion: 8,
    rendererVersion: '8.0.0',
    stagingBaseSha: 'd'.repeat(40),
    stagingCommitSha,
    commitUrl: `https://github.com/PointCommunity/pointsite-staging/commit/${stagingCommitSha}`,
    requestedAt: '2026-09-07T12:00:00Z',
    completedAt: '2026-09-07T12:01:00Z',
    evidence: { verificationStatus: 'pending' },
  },
  approval: null,
  ...overrides,
});

const derive = (current: StagingWorkflowSnapshot | null | undefined, monitoringPaused = false) =>
  deriveStagingWorkflow({
    revisionId,
    revisionChecksum,
    snapshot: current,
    monitoringPaused,
  });

describe('Staging workflow lifecycle', () => {
  it('distinguishes loading, unavailable, and ready before publication', () => {
    expect(derive(undefined)).toMatchObject({ phase: 'loading', step: 1 });
    expect(derive(null)).toMatchObject({
      phase: 'unavailable',
      step: 1,
      canRefresh: true,
      canPublish: false,
    });
    expect(derive(snapshot({ job: null }))).toMatchObject({
      phase: 'ready',
      step: 1,
      canPublish: true,
      shouldPoll: false,
    });
  });

  it('maps a queued or running durable job to publishing and locks duplicate publication', () => {
    for (const status of ['queued', 'running'] as const) {
      const state = derive(snapshot({ job: { ...snapshot().job!, status } }));
      expect(state).toMatchObject({
        phase: 'publishing',
        step: 2,
        canPublish: false,
        shouldPoll: true,
      });
    }
  });

  it('maps exact-commit pending evidence to bounded automatic verification', () => {
    expect(derive(snapshot())).toMatchObject({
      phase: 'verifying',
      step: 3,
      canRefresh: true,
      canAccept: false,
      shouldPoll: true,
    });
    expect(derive(snapshot(), true)).toMatchObject({
      phase: 'paused',
      step: 3,
      canRefresh: true,
      shouldPoll: false,
    });
  });

  it('unlocks protected review and deliberate acceptance only after exact evidence passes', () => {
    const passed = snapshot({
      job: {
        ...snapshot().job!,
        evidence: { verificationStatus: 'passed', checks: { live: true } },
      },
    });
    expect(derive(passed)).toMatchObject({
      phase: 'review-ready',
      step: 4,
      canAccept: true,
      shouldPoll: false,
    });
    expect(
      derive({
        ...passed,
        approval: {
          id: '40000000-0000-4000-8000-000000000001',
          publishJobId: passed.job!.id,
          decision: 'approved',
          createdAt: '2026-09-07T12:02:00Z',
        },
      }),
    ).toMatchObject({
      phase: 'accepted',
      step: 5,
      canAccept: false,
      shouldPoll: false,
    });
  });

  it('gives retry or refresh recovery for publish and verification failures', () => {
    expect(
      derive(
        snapshot({
          currentStagingSha: 'd'.repeat(40),
          job: {
            ...snapshot().job!,
            status: 'failed',
            stagingCommitSha: null,
            commitUrl: null,
            evidence: { failureCode: 'GITHUB_TEST_FAILURE' },
          },
        }),
      ),
    ).toMatchObject({ phase: 'failed', step: 2, canPublish: true, canRefresh: true });

    expect(
      derive(
        snapshot({
          job: {
            ...snapshot().job!,
            evidence: { verificationStatus: 'failed', failedChecks: ['deploy'] },
          },
        }),
      ),
    ).toMatchObject({ phase: 'failed', step: 3, canPublish: false, canRefresh: true });
  });

  it('invalidates incompatible jobs and approvals after revision or Staging drift', () => {
    expect(
      derive(
        snapshot({
          job: { ...snapshot().job!, revisionId: '20000000-0000-4000-8000-000000000099' },
        }),
      ),
    ).toMatchObject({ phase: 'stale', step: 1, canPublish: true, canAccept: false });

    const accepted = snapshot({
      currentStagingSha: 'f'.repeat(40),
      approval: {
        id: '40000000-0000-4000-8000-000000000001',
        publishJobId: snapshot().job!.id,
        decision: 'approved',
        createdAt: '2026-09-07T12:02:00Z',
      },
    });
    expect(derive(accepted)).toMatchObject({
      phase: 'stale',
      step: 1,
      canPublish: true,
      canAccept: false,
    });
  });
});
