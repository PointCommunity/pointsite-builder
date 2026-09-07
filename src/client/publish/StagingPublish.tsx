import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ClientApiError, type CandidateTuple } from '../api';
import { useEditor } from '../editor/EditorProvider';
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

const actionErrorMessage = (error: unknown) => {
  if (!(error instanceof ClientApiError))
    return 'Staging could not be reached. Your draft and the public website are unchanged.';
  if (error.status === 403)
    return 'Your publishing permission is no longer active. Ask an Administrator to review access.';
  if (error.status === 429) return 'Too many requests arrived at once. Wait briefly, then refresh.';
  if (error.code === 'DRAFT_REVISION_DRIFT')
    return 'The draft changed. Close and reopen Publish to use the latest saved revision.';
  if (error.code === 'STAGING_BASE_DRIFT' || error.code === 'STAGING_CANDIDATE_DRIFT')
    return 'Protected Staging changed. Refresh, then publish a new exact candidate.';
  if (error.code === 'PUBLISH_IN_PROGRESS')
    return 'This publication is already running. Refresh to resume its progress.';
  return error.message || 'The action stopped safely. Refresh the workflow and try again.';
};

export function StagingPublish() {
  const { draft, saveState } = useEditor();
  const [snapshot, setSnapshot] = useState<StagingWorkflowSnapshot | null | undefined>(undefined);
  const [monitoringStartedAt, setMonitoringStartedAt] = useState<number | null>(null);
  const [monitoringPaused, setMonitoringPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const loadWorkflow = useCallback(async () => {
    try {
      const restored = await api.getStagingWorkflow(draft.id);
      setSnapshot(restored);
      return restored;
    } catch (error) {
      setSnapshot(null);
      setActionError(actionErrorMessage(error));
      return null;
    }
  }, [draft.id]);

  useEffect(() => {
    setSnapshot(undefined);
    setMonitoringStartedAt(null);
    setMonitoringPaused(false);
    setActionError('');
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

  const refresh = useCallback(async () => {
    setBusy(true);
    setActionError('');
    try {
      const currentJob = snapshot?.job;
      if (currentJob?.status === 'succeeded' && currentJob.evidence.verificationStatus !== 'passed')
        await api.refreshStagingVerification(currentJob.id);
      await loadWorkflow();
    } catch (error) {
      setActionError(actionErrorMessage(error));
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
    setActionError('');
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
      setActionError(actionErrorMessage(error));
      await loadWorkflow();
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    const currentJob = snapshot?.job;
    if (!currentJob?.stagingCommitSha) return;
    setBusy(true);
    setActionError('');
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
      setActionError(actionErrorMessage(error));
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
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}

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
                ? 'Publish this revision to Staging'
                : 'Publish a new Staging candidate'}
          </button>
        ) : null}
        {lifecycle.canRefresh ? (
          <button className="button" type="button" disabled={busy} onClick={() => void refresh()}>
            {busy ? 'Refreshing…' : 'Refresh Staging status'}
          </button>
        ) : null}
      </div>

      {lifecycle.phase === 'review-ready' || lifecycle.phase === 'accepted' ? (
        <section className="staging-review" aria-labelledby="staging-review-title">
          <p className="eyebrow">Protected review</p>
          <h3 id="staging-review-title">Review the exact site before acceptance</h3>
          <p>Open Staging, check the affected pages and interactions, then return here.</p>
          <a className="button" href={snapshot?.reviewUrl} target="_blank" rel="noreferrer">
            Review protected Staging site
          </a>
          {lifecycle.canAccept ? (
            <button
              className="button button--primary"
              type="button"
              disabled={busy}
              onClick={() => void accept()}
            >
              I reviewed Staging — accept this revision
            </button>
          ) : null}
        </section>
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
          Only protected Staging can change here. Publishing the public website requires a separate
          Administrator-only process.
        </p>
      </aside>
    </section>
  );
}
