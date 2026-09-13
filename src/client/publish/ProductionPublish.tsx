import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ClientApiError } from '../api';
import type { ProductionWorkflowSnapshot, StagingAcceptanceSummary } from './workflow';

type RecoveryAction = Parameters<typeof api.recoverProduction>[1];

export function ProductionPublish({
  draftId,
  approval,
}: {
  draftId: string;
  approval: StagingAcceptanceSummary | null;
}) {
  const [snapshot, setSnapshot] = useState<ProductionWorkflowSnapshot | null>();
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ scope: string; key: string } | null>(null);
  const reading = useRef({ generation: 0 });
  const acting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(async () => {
    const generation = ++reading.current.generation;
    try {
      const value = await api.getProductionWorkflow(draftId);
      if (generation === reading.current.generation) setSnapshot(value);
    } catch {
      if (generation === reading.current.generation) setSnapshot(null);
    }
  }, [draftId]);
  useEffect(() => {
    const state = reading.current;
    void load();
    return () => {
      ++state.generation;
    };
  }, [load]);
  const job = snapshot?.enabled ? snapshot.job : null;
  const dispatch = job?.dispatch;
  const active = job?.status === 'queued' || job?.status === 'running';
  useEffect(() => {
    if (!active || busy || dispatch?.needsAttention) return;
    const remaining = Date.parse(job.requestedAt) + 15 * 60_000 - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setPaused(true);
      return;
    }
    setPaused(false);
    const timer = window.setTimeout(() => void load(), Math.min(10_000, remaining));
    return () => window.clearTimeout(timer);
  }, [active, busy, dispatch?.needsAttention, job, load]);

  const act = async (action: 'promote' | RecoveryAction) => {
    if (acting.current || !snapshot?.enabled) return;
    const scope =
      action === 'promote'
        ? JSON.stringify([draftId, approval?.id, approval?.tuple])
        : JSON.stringify([job?.id, action, dispatch?.attempts, dispatch?.retryAt]);
    if (request.current?.scope !== scope) request.current = { scope, key: crypto.randomUUID() };
    acting.current = true;
    ++reading.current.generation;
    setBusy(true);
    setError(null);
    try {
      if (action === 'promote') {
        if (!approval?.tuple || approval.decision !== 'approved') return;
        await api.publishProduction(
          approval.publishJobId,
          approval.id,
          approval.tuple,
          request.current.key,
        );
      } else {
        if (!job || !dispatch) return;
        await api.recoverProduction(job.id, action, dispatch.attempts, request.current.key);
      }
      request.current = null;
    } catch (failure) {
      setError(
        `The action could not be confirmed. Check Production status before trying again.${
          failure instanceof ClientApiError && failure.requestId
            ? ` Support reference: ${failure.requestId}.`
            : ''
        }`,
      );
    } finally {
      await load();
      acting.current = false;
      setBusy(false);
      heading.current?.focus();
    }
  };
  const canPromote =
    snapshot?.enabled &&
    !snapshot.busy &&
    !active &&
    approval?.decision === 'approved' &&
    approval.tuple &&
    'publicationProtocol' in approval.tuple &&
    approval.tuple.publicationProtocol === 2 &&
    job?.approvalId !== approval.id;
  const queued = job?.status === 'queued' && dispatch?.reserved === false;

  return (
    <aside className="production-lock" aria-labelledby="production-heading">
      <h2 id="production-heading" tabIndex={-1} ref={heading}>
        Production
      </h2>
      {snapshot === undefined ? (
        <p role="status">Loading Production status…</p>
      ) : snapshot === null ? (
        <p role="status">
          Production status is unavailable. Check status before taking another action.
        </p>
      ) : !snapshot.enabled ? (
        <p>
          Production publishing is not enabled in Builder yet. Its protected setup and recovery
          checks must finish first.
        </p>
      ) : (
        <>
          <p role="status">
            {!job
              ? 'No Production publication is recorded for this draft.'
              : dispatch?.needsAttention
                ? 'Production publication needs attention'
                : active
                  ? 'The captured Production version continues in the cloud, even after you close Builder.'
                  : job.status === 'succeeded' &&
                      job.evidence.verificationStatus === 'passed' &&
                      job.evidence.artifactDigest === job.artifactDigest
                    ? 'This Production publication was verified.'
                    : job.status === 'cancelled'
                      ? 'This Production publication was cancelled.'
                      : 'Production publication needs reconciliation before another attempt.'}
          </p>
          {active && paused ? (
            <p>Automatic monitoring paused. Check Production status to read the latest progress.</p>
          ) : null}
          {snapshot.busy && !active ? (
            <p>
              Another Production publication needs to finish or be reconciled before publishing.
            </p>
          ) : null}
          {canPromote ? (
            <>
              <p>
                This replaces the public website with the exact accepted Staging version. Newer
                draft edits are excluded.
              </p>
              <details>
                <summary>Accepted version details</summary>
                <dl>
                  <dt>Revision</dt>
                  <dd>{approval.tuple?.revisionId}</dd>
                  <dt>Acceptance</dt>
                  <dd>{approval.id}</dd>
                  <dt>Staging commit</dt>
                  <dd>{approval.tuple?.stagingCommitSha}</dd>
                </dl>
              </details>
              <button
                className="button button--primary"
                type="button"
                disabled={busy}
                onClick={() => void act('promote')}
              >
                Publish accepted version to Production
              </button>
            </>
          ) : null}
          {queued ? (
            <>
              {dispatch.needsAttention ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy || !(Date.parse(dispatch.retryAt) <= Date.now())}
                  onClick={() => void act('retry')}
                >
                  Retry Production dispatch
                </button>
              ) : null}
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void act('cancel')}
              >
                Cancel queued Production publication
              </button>
            </>
          ) : null}
          {dispatch?.canReconcileStopped ? (
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => void act('reconcile')}
            >
              Reconcile stopped Production run
            </button>
          ) : null}
          {dispatch?.canRetryCaptured ? (
            <button
              className="button"
              type="button"
              disabled={busy || snapshot.busy}
              onClick={() => void act('retry-captured')}
            >
              Retry captured Production version
            </button>
          ) : null}
          {dispatch?.canVerifyCompleted ? (
            <>
              <p>Verify the existing deployment without publishing again.</p>
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void act('verify-completed')}
              >
                Verify completed Production publication
              </button>
            </>
          ) : null}
          {job ? (
            <details>
              <summary>Production publication details</summary>
              <dl>
                <dt>Captured revision</dt>
                <dd>{job.revisionId}</dd>
                <dt>Acceptance</dt>
                <dd>{job.approvalId}</dd>
                <dt>Artifact</dt>
                <dd>{job.artifactDigest}</dd>
                <dt>Publication</dt>
                <dd>{job.id}</dd>
                <dt>Commit</dt>
                <dd>{job.commitSha ?? 'Not recorded'}</dd>
              </dl>
              {dispatch?.workflowUrl ? (
                <a href={dispatch.workflowUrl} target="_blank" rel="noreferrer">
                  Production cloud progress
                </a>
              ) : null}
              {job.evidence.deploymentUrl ? (
                <a href={job.evidence.deploymentUrl} target="_blank" rel="noreferrer">
                  Production deployment evidence
                </a>
              ) : null}
            </details>
          ) : null}
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {snapshot?.enabled !== false ? (
        <button className="button" type="button" disabled={busy} onClick={() => void load()}>
          Check Production status
        </button>
      ) : null}
      <p className="production-role-note">
        A GitHub organization owner must also have an active Builder Administrator role and the
        required live repository permission to authorize a Production publication.
      </p>
    </aside>
  );
}
