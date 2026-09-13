import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  ['Private preflight', 'Check one exact saved version without changing Staging.'],
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
  const publishRequest = useRef<{ scope: string; key: string } | null>(null);
  const recoveryRequest = useRef<{ scope: string; key: string } | null>(null);

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
      ? 'Review the failed Staging check'
      : failedChecks.length > 1
        ? `Review ${failedChecks.length} failed Staging checks`
        : 'Review the failed Staging checks';
  const fallbackChecksUrl = snapshot?.job?.commitUrl
    ? `${snapshot.job.commitUrl}/checks`
    : undefined;

  const refresh = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      const currentJob = snapshot?.job;
      if (
        currentJob?.publicationProtocol !== 2 &&
        (currentJob?.status === 'running' || currentJob?.status === 'queued')
      )
        await api.continueStagingPublication(currentJob.id);
      if (
        currentJob?.publicationProtocol !== 2 &&
        lifecycle.phase !== 'waiting' &&
        currentJob?.status === 'succeeded' &&
        currentJob.evidence.verificationStatus !== 'passed'
      )
        await api.refreshStagingVerification(currentJob.id);
      await loadWorkflow();
    } catch (error) {
      setActionError(actionFailure(error));
      setMonitoringPaused(true);
    } finally {
      setBusy(false);
    }
  }, [lifecycle.phase, loadWorkflow, snapshot?.job]);

  useEffect(() => {
    if (!lifecycle.shouldPoll || busy) return;
    const recordedAt = snapshot?.job
      ? Date.parse(snapshot.job.completedAt ?? snapshot.job.requestedAt)
      : Date.now();
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
      let current = snapshot;
      if (current.preflight.state !== 'passed') {
        await api.preflightStaging(draft.id, draft.revision.id, draft.revision.checksum);
        const refreshed = await loadWorkflow();
        if (!refreshed) return;
        current = refreshed;
      }
      if (current.availability.state === 'busy') return;
      const scope = JSON.stringify([
        draft.id,
        draft.revision.id,
        draft.revision.checksum,
        current.currentStagingSha,
        current.job?.id,
        current.job?.status,
      ]);
      if (publishRequest.current?.scope !== scope)
        publishRequest.current = { scope, key: crypto.randomUUID() };
      await api.publishStaging(
        draft.id,
        draft.revision.id,
        draft.revision.checksum,
        current.currentStagingSha,
        publishRequest.current.key,
      );
      publishRequest.current = null;
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

  const recoverQueued = async (action: 'retry' | 'cancel' | 'reconcile') => {
    const job = snapshot?.job;
    if (
      !job ||
      job.publicationProtocol !== 2 ||
      !job.dispatch ||
      !(
        (job.status === 'queued' && job.dispatch.reserved === false) ||
        (action === 'reconcile' && job.dispatch.canReconcileStopped === true)
      )
    )
      return;
    const scope = JSON.stringify([job.id, action, job.dispatch.attempts, job.dispatch.retryAt]);
    if (recoveryRequest.current?.scope !== scope)
      recoveryRequest.current = { scope, key: crypto.randomUUID() };
    setBusy(true);
    setActionError(null);
    try {
      await api.recoverQueuedPublication(
        job.id,
        action,
        job.dispatch.attempts,
        recoveryRequest.current.key,
      );
      recoveryRequest.current = null;
      setMonitoringStartedAt(action === 'retry' ? Date.now() : null);
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
        ...(currentJob.publicationProtocol === 2
          ? {
              publicationProtocol: 2 as const,
              workflowRevision: currentJob.workflowRevision!,
              artifactDigest: currentJob.evidence.artifactDigest!,
            }
          : {}),
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
      if (currentJob.publicationProtocol === 2)
        await api.acceptStaging(
          currentJob.id,
          tuple,
          'Protected Staging reviewed in Builder',
          snapshot?.approval?.id ?? null,
        );
      else await api.acceptStaging(currentJob.id, tuple, 'Protected Staging reviewed in Builder');
      await loadWorkflow();
    } catch (error) {
      setActionError(actionFailure(error));
      await loadWorkflow();
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    const approval = snapshot?.approval;
    if (!approval?.tuple || approval.decision !== 'approved') return;
    setBusy(true);
    setActionError(null);
    try {
      await api.revokeStaging(approval.publishJobId, approval.tuple, approval.id);
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
        {snapshot?.job?.publicationProtocol === 2 &&
        snapshot.job.revisionId !== draft.revision.id &&
        ['review-ready', 'accepted'].includes(lifecycle.phase) ? (
          <p>
            <strong>Newer edits are not included.</strong> Review the version captured for Staging;
            your latest draft remains separate.
          </p>
        ) : null}

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
              <li>Automatic recovery has already checked whether Staging finished successfully.</li>
              <li>Open each failed check above and read its latest result.</li>
              <li>
                Do not publish the draft again just to clear this message.{' '}
                {role === 'administrator'
                  ? 'Send the failed-check link to the site maintainer so they can fix the website system.'
                  : 'Ask a Builder Administrator or site maintainer to use the failed-check link to fix the website system.'}
              </li>
              <li>Return here after it is repaired, then check Staging status again.</li>
            </ol>
            <button
              className="button button--primary"
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? 'Checking…' : 'Check Staging status again'}
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
                  : (nextStep.primaryAction ?? `Publish revision ${draft.revision.sequence}`)}
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
                    ? lifecycle.step === 2
                      ? 'Check publication status'
                      : 'Continue verification'
                    : lifecycle.phase === 'unavailable'
                      ? 'Try loading again'
                      : lifecycle.phase === 'waiting'
                        ? 'Check availability'
                        : 'Check now'}
              </button>
            ) : null}
          </div>
        )}

        <p className="publish-action-impact">
          <strong>What this means: </strong>
          {nextStep.effect}
        </p>
        {snapshot?.job?.publicationProtocol === 2 &&
        snapshot.job.status === 'queued' &&
        snapshot.job.dispatch?.reserved === false ? (
          <div className="publish-actions">
            {snapshot.job.dispatch.needsAttention ? (
              <button
                className="button"
                type="button"
                disabled={busy || Date.parse(snapshot.job.dispatch.retryAt) > Date.now()}
                onClick={() => void recoverQueued('retry')}
              >
                Retry queued publication
              </button>
            ) : null}
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => void recoverQueued('cancel')}
            >
              Cancel queued publication
            </button>
          </div>
        ) : null}
        {snapshot?.job?.publicationProtocol === 2 &&
        snapshot.job.dispatch?.canReconcileStopped === true ? (
          <div className="publish-actions">
            <p>
              If the cloud run stopped before publishing, Builder can check it and release this job.
            </p>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => void recoverQueued('reconcile')}
            >
              Recover stopped publication
            </button>
          </div>
        ) : null}
        {lifecycle.phase === 'accepted' ? (
          <a className="button" href={snapshot?.reviewUrl} target="_blank" rel="noreferrer">
            Open accepted Staging site
          </a>
        ) : null}
        {snapshot?.approval?.decision === 'approved' &&
        snapshot?.job?.publicationProtocol === 2 &&
        snapshot.approval?.tuple ? (
          <button className="button" type="button" disabled={busy} onClick={() => void revoke()}>
            {busy ? 'Revoking…' : 'Revoke Staging acceptance'}
          </button>
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
        {lifecycle.phase === 'waiting' && snapshot?.availability.state === 'busy' ? (
          <p>
            {snapshot.availability.retryAt ? (
              <>
                Another publication is currently{' '}
                {snapshot.availability.phase === 'queued' ? 'preparing' : 'publishing'}. Builder can
                check recovery after{' '}
                <time dateTime={snapshot.availability.retryAt}>
                  {new Date(snapshot.availability.retryAt).toLocaleString()}
                </time>
                .
              </>
            ) : snapshot.availability.phase === 'review' ? (
              'Staging is reserved for review of the captured version.'
            ) : (
              'Staging stays reserved until the captured publication is finished or safely reconciled.'
            )}
          </p>
        ) : null}
      </div>
      {lifecycle.shouldPoll && monitoringStartedAt !== null ? (
        <p className="publish-monitoring-note">
          Automatic updates are on. Builder checks this workflow every 10 seconds for up to 15
          minutes.
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
          <div>
            <dt>Private preflight</dt>
            <dd>
              {snapshot?.preflight.state === 'passed'
                ? `Passed ${new Date(snapshot.preflight.validatedAt).toLocaleString()}`
                : 'Required'}
            </dd>
          </div>
          {snapshot?.job ? (
            <>
              {snapshot.job.publicationProtocol === 2 ? (
                <div>
                  <dt>Captured revision ID</dt>
                  <dd>{snapshot.job.revisionId}</dd>
                </div>
              ) : null}
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
          {snapshot?.job?.dispatch?.workflowUrl ? (
            <a href={snapshot.job.dispatch.workflowUrl} target="_blank" rel="noreferrer">
              Cloud publication progress
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
