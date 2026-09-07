import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ClientApiError, type CandidateTuple } from '../api';
import { useEditor } from '../editor/EditorProvider';
import {
  describeFailedCheck,
  getActionFailureGuidance,
  getPublishingNextStep,
  type ActionFailureGuidance,
  type PublishingRole,
} from './guidance';
import { deriveStagingWorkflow, type StagingWorkflowSnapshot } from './workflow';

const POLL_INTERVAL_MS = 10_000;
const MONITORING_LIMIT_MS = 15 * 60_000;
const steps = [
  ['Saved revision', 'Choose one exact saved version.'],
  ['Publish', 'Create one protected Staging candidate.'],
  ['Verify', 'Follow required quality and deployment checks.'],
  ['Review', 'Open the protected Staging website.'],
  ['Accept', 'Record the official Staging candidate.'],
] as const;

type DisplayActionFailure = ActionFailureGuidance & {
  code?: string;
  requestId?: string;
};

const actionFailure = (error: unknown): DisplayActionFailure => {
  if (!(error instanceof ClientApiError)) return getActionFailureGuidance('REQUEST_FAILED');
  const code =
    error.code === 'REQUEST_FAILED' && error.status === 403
      ? 'FORBIDDEN'
      : error.code === 'REQUEST_FAILED' && error.status === 429
        ? 'RATE_LIMITED'
        : error.code;
  return {
    ...getActionFailureGuidance(code),
    code,
    requestId: error.requestId,
  };
};

export function StagingPublish({ role }: { role: PublishingRole }) {
  const { draft, saveState } = useEditor();
  const [snapshot, setSnapshot] = useState<StagingWorkflowSnapshot | null | undefined>(undefined);
  const [monitoringStartedAt, setMonitoringStartedAt] = useState<number | null>(null);
  const [monitoringPaused, setMonitoringPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<DisplayActionFailure | null>(null);

  const loadWorkflow = useCallback(async () => {
    try {
      const restored = await api.getStagingWorkflow(draft.id);
      setSnapshot(restored);
      return restored;
    } catch (error) {
      setSnapshot(null);
      setActionError(actionFailure(error));
      return null;
    }
  }, [draft.id]);

  useEffect(() => {
    setSnapshot(undefined);
    setMonitoringStartedAt(null);
    setMonitoringPaused(false);
    setActionError(null);
    void loadWorkflow();
  }, [draft.revision.id, draft.revision.checksum, loadWorkflow]);

  const lifecycle = useMemo(
    () =>
      deriveStagingWorkflow({
        revisionId: draft.revision.id,
        revisionChecksum: draft.revision.checksum,
        snapshot,
        monitoringPaused,
      }),
    [draft.revision.checksum, draft.revision.id, monitoringPaused, snapshot],
  );
  const nextStep = getPublishingNextStep(lifecycle, role, draft.revision.sequence);
  const roleLabel = role === 'administrator' ? 'Administrator' : 'Publisher';
  const verificationFailed = lifecycle.phase === 'failed' && lifecycle.step === 3;
  const failedChecks = snapshot?.job?.evidence.failedChecks ?? [];
  const failedChecksTitle =
    failedChecks.length === 1
      ? 'Resolve the failed Staging check'
      : failedChecks.length > 1
        ? `Resolve ${failedChecks.length} failed Staging checks`
        : 'Resolve the failed Staging checks';
  const fallbackChecksUrl = snapshot?.job?.commitUrl
    ? `${snapshot.job.commitUrl}/checks`
    : undefined;

  const refresh = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      const currentJob = snapshot?.job;
      if (currentJob?.status === 'succeeded' && currentJob.evidence.verificationStatus !== 'passed')
        await api.refreshStagingVerification(currentJob.id);
      await loadWorkflow();
    } catch (error) {
      setActionError(actionFailure(error));
      setMonitoringPaused(true);
    } finally {
      setBusy(false);
    }
  }, [loadWorkflow, snapshot?.job]);

  useEffect(() => {
    if (!lifecycle.shouldPoll || !snapshot?.job || busy) return;
    const recordedAt = Date.parse(snapshot.job.completedAt ?? snapshot.job.requestedAt);
    const startedAt =
      monitoringStartedAt ?? (Number.isFinite(recordedAt) ? recordedAt : Date.now());
    if (monitoringStartedAt === null) setMonitoringStartedAt(startedAt);
    const remaining = MONITORING_LIMIT_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      setMonitoringPaused(true);
      return;
    }
    const timer = window.setTimeout(() => void refresh(), Math.min(POLL_INTERVAL_MS, remaining));
    return () => window.clearTimeout(timer);
  }, [busy, lifecycle.shouldPoll, monitoringStartedAt, refresh, snapshot?.job]);

  const publish = async () => {
    if (!snapshot) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.publishStaging(
        draft.id,
        draft.revision.id,
        draft.revision.checksum,
        snapshot.currentStagingSha,
      );
      setMonitoringStartedAt(Date.now());
      setMonitoringPaused(false);
      await loadWorkflow();
    } catch (error) {
      setActionError(actionFailure(error));
      await loadWorkflow();
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    const currentJob = snapshot?.job;
    if (!currentJob?.stagingCommitSha) return;
    setBusy(true);
    setActionError(null);
    try {
      const production = await api.productionBase();
      const tuple: CandidateTuple = {
        siteId: 'pointsite',
        revisionId: currentJob.revisionId,
        revisionChecksum: currentJob.revisionChecksum,
        schemaVersion: currentJob.schemaVersion,
        rendererVersion: currentJob.rendererVersion,
        candidateChecksum: currentJob.candidateChecksum,
        stagingBaseSha: currentJob.stagingBaseSha,
        stagingCommitSha: currentJob.stagingCommitSha,
        productionBaseSha: production.sha,
      };
      await api.acceptStaging(currentJob.id, tuple, 'Protected Staging reviewed in Builder');
      await loadWorkflow();
    } catch (error) {
      setActionError(actionFailure(error));
      await loadWorkflow();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="publish-panel" aria-labelledby="publish-title">
      <p className="eyebrow">Staging only</p>
      <h2 id="publish-title">Publish and accept on Staging</h2>
      <p>
        Follow one saved version of <strong>{draft.name}</strong> from publication through official
        Staging acceptance. The public website does not change during this workflow.
      </p>

      <ol className="publish-steps" aria-label="Staging publishing progress">
        {steps.map(([label, description], index) => {
          const number = index + 1;
          const stepState =
            lifecycle.phase === 'accepted' || number < lifecycle.step
              ? 'complete'
              : number === lifecycle.step
                ? 'current'
                : 'upcoming';
          return (
            <li
              key={label}
              data-state={stepState}
              aria-current={stepState === 'current' ? 'step' : undefined}
            >
              <span className="publish-step-marker" aria-hidden="true">
                {stepState === 'complete' ? '✓' : number}
              </span>
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
            </li>
          );
        })}
      </ol>

      <section className="publish-next-action" aria-labelledby="publish-next-action-title">
        <p className="eyebrow">Your next step · {roleLabel}</p>
        <h3 id="publish-next-action-title">
          {verificationFailed ? failedChecksTitle : nextStep.title}
        </h3>
        <p>{nextStep.guidance}</p>

        {verificationFailed ? (
          <div className="publish-failure-recovery">
            {failedChecks.length > 0 ? (
              <ul className="publish-failed-checks" aria-label="Failed Staging checks">
                {failedChecks.map((check) => {
                  const description = describeFailedCheck(check);
                  const url = snapshot?.job?.evidence.failedCheckUrls?.[check] ?? fallbackChecksUrl;
                  const actionLabel =
                    check === 'verify'
                      ? 'Open website safety check'
                      : check === 'deploy'
                        ? 'Open Staging update check'
                        : `Open ${description.label} evidence`;
                  return (
                    <li key={check}>
                      <strong>{description.label}</strong>
                      <span>{description.explanation}</span>
                      {url ? (
                        <a className="button" href={url} target="_blank" rel="noreferrer">
                          {actionLabel}
                        </a>
                      ) : (
                        <span>
                          A check link is unavailable. Ask a site maintainer to open this publish
                          job from Technical evidence below.
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p>
                Builder did not receive the failed check names. Open the commit under Technical
                evidence below, or give the publish job number to a site maintainer.
              </p>
            )}

            <h4>How to resolve this</h4>
            <ol className="publish-recovery-steps">
              <li>Open each failed check above and read its latest result.</li>
              <li>If GitHub shows “Re-run jobs,” choose “Re-run failed jobs” once.</li>
              <li>
                If the same check fails again—or no re-run option appears—do not change the draft
                just to clear this message.{' '}
                {role === 'administrator'
                  ? 'Send the failed-check link to the site maintainer so they can fix the website system.'
                  : 'Ask a Builder Administrator or site maintainer to use the failed-check link to fix the website system.'}
              </li>
              <li>Return here after the check was rerun or repaired, then check its result.</li>
            </ol>
            <button
              className="button button--primary"
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? 'Checking…' : 'I reran the checks — check again'}
            </button>
          </div>
        ) : lifecycle.phase === 'review-ready' ? (
          <ol className="publish-review-actions" aria-label="Required Staging review actions">
            <li>
              <strong>Open and review Staging</strong>
              <span>Check the affected pages and interactions in the protected website.</span>
              <a
                className="button button--primary"
                href={snapshot?.reviewUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Staging for review
              </a>
            </li>
            <li>
              <strong>Return here and accept it</strong>
              <span>Accept only after the protected site looks and works as expected.</span>
              <button
                className="button button--primary"
                type="button"
                disabled={busy}
                onClick={() => void accept()}
              >
                {busy ? 'Accepting…' : 'Accept this Staging version'}
              </button>
            </li>
          </ol>
        ) : (
          <div className="publish-actions">
            {lifecycle.canPublish ? (
              <button
                className="button button--primary"
                type="button"
                disabled={busy || saveState !== 'saved'}
                onClick={() => void publish()}
              >
                {busy
                  ? 'Starting publication…'
                  : lifecycle.phase === 'ready'
                    ? `Publish revision ${draft.revision.sequence} to Staging`
                    : lifecycle.phase === 'stale'
                      ? `Publish current revision ${draft.revision.sequence}`
                      : 'Try publishing again'}
              </button>
            ) : null}
            {lifecycle.canRefresh && lifecycle.phase !== 'accepted' ? (
              <button
                className={`button ${
                  ['paused', 'unavailable'].includes(lifecycle.phase) ||
                  (lifecycle.phase === 'failed' && !lifecycle.canPublish)
                    ? 'button--primary'
                    : ''
                }`}
                type="button"
                disabled={busy}
                onClick={() => void refresh()}
              >
                {busy
                  ? 'Checking…'
                  : lifecycle.phase === 'paused'
                    ? 'Continue verification'
                    : lifecycle.phase === 'unavailable'
                      ? 'Try loading again'
                      : 'Check now'}
              </button>
            ) : null}
          </div>
        )}

        <p className="publish-action-impact">
          <strong>What this means: </strong>
          {nextStep.effect}
        </p>
        {lifecycle.phase === 'accepted' ? (
          <a className="button" href={snapshot?.reviewUrl} target="_blank" rel="noreferrer">
            Open accepted Staging site
          </a>
        ) : null}
      </section>

      <div
        className={`publish-status publish-status--${lifecycle.phase}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <strong>{lifecycle.title}</strong>
        <p>{lifecycle.guidance}</p>
      </div>
      {lifecycle.shouldPoll && monitoringStartedAt !== null ? (
        <p className="publish-monitoring-note">
          Automatic updates are on. Builder checks every 10 seconds for up to 15 minutes.
        </p>
      ) : null}
      {actionError ? (
        <div className="publish-action-error" role="alert">
          <strong>{actionError.title}</strong>
          <p>{actionError.guidance}</p>
          {actionError.requestId || actionError.code ? (
            <small>
              Support reference: {actionError.requestId ?? 'not available'}
              {actionError.code ? ` · ${actionError.code}` : ''}
            </small>
          ) : null}
        </div>
      ) : null}

      <details className="technical-details">
        <summary tabIndex={0}>Technical evidence</summary>
        <dl>
          <div>
            <dt>Saved version</dt>
            <dd>Revision {draft.revision.sequence}</dd>
          </div>
          <div>
            <dt>Revision ID</dt>
            <dd>{draft.revision.id}</dd>
          </div>
          <div>
            <dt>Content checksum</dt>
            <dd>{draft.revision.checksum}</dd>
          </div>
          <div>
            <dt>Current Staging version</dt>
            <dd>{snapshot?.currentStagingSha ?? 'Unavailable'}</dd>
          </div>
          {snapshot?.job ? (
            <>
              <div>
                <dt>Publish job</dt>
                <dd>{snapshot.job.id}</dd>
              </div>
              <div>
                <dt>Candidate checksum</dt>
                <dd>{snapshot.job.candidateChecksum}</dd>
              </div>
              <div>
                <dt>Candidate commit</dt>
                <dd>{snapshot.job.stagingCommitSha ?? 'Not created'}</dd>
              </div>
            </>
          ) : null}
        </dl>
        <div className="technical-links">
          {snapshot?.job?.commitUrl ? (
            <a href={snapshot.job.commitUrl} target="_blank" rel="noreferrer">
              Commit evidence
            </a>
          ) : null}
          {snapshot?.job?.evidence.workflowUrl ? (
            <a href={snapshot.job.evidence.workflowUrl} target="_blank" rel="noreferrer">
              Quality evidence
            </a>
          ) : null}
          {snapshot?.job?.evidence.deploymentUrl ? (
            <a href={snapshot.job.evidence.deploymentUrl} target="_blank" rel="noreferrer">
              Deployment evidence
            </a>
          ) : null}
        </div>
      </details>

      <aside className="production-lock">
        <strong>Production remains unchanged</strong>
        <p>
          {role === 'administrator'
            ? 'Production publishing is not enabled in Builder yet. There is no Production button until the separate protected setup and approval are complete.'
            : 'Your Publisher role ends at accepted Staging. An Administrator can continue only after the separate protected Production workflow is enabled.'}
        </p>
        <p className="production-role-note">
          A GitHub organization owner must also have an active Builder Administrator role and the
          required live repository permission before any Production action can appear.
        </p>
      </aside>
    </section>
  );
}
