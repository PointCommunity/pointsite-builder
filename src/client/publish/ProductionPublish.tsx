import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { ProductionWorkflowSnapshot, StagingAcceptanceSummary } from './workflow';
import { PublicationVerification } from './PublicationVerification';
import { ProductionRollback } from './ProductionRollback';
import { PublishingDialog } from './PublishingDialog';
import {
  PublishingDetails,
  CopyPublishingDetails,
  usePublishingSupport,
  supportError,
} from './PublishingSupport';
import { PublicationProgress } from './PublicationProgress';

type RecoveryAction = Parameters<typeof api.recoverProduction>[1];

export function ProductionPublish({
  draftId,
  approval,
  stagingReady = true,
  stagingOrigin,
  dangerActions,
}: {
  draftId: string;
  stagingReady?: boolean;
  stagingOrigin?: string;
  dangerActions?: ReactNode;
  approval: StagingAcceptanceSummary | null;
}) {
  const [snapshot, setSnapshot] = useState<ProductionWorkflowSnapshot | null>();
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof supportError> | null>(null);
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
    } catch (error) {
      if (generation === reading.current.generation) {
        setSnapshot(null);
        setFailure(supportError(error));
      }
    }
  }, [draftId]);
  const refreshVerification = useCallback(
    async (focus = false) => {
      await load();
      if (focus) heading.current?.focus();
    },
    [load],
  );
  useEffect(() => {
    const state = reading.current;
    void load();
    return () => {
      ++state.generation;
    };
  }, [load]);
  const job = snapshot?.enabled ? snapshot.job : null;
  const destination = snapshot?.enabled ? snapshot.destination : undefined;
  const label =
    destination?.repository === 'pointsite-canary'
      ? 'Site Canary'
      : destination
        ? 'Site Production'
        : 'Public site';
  const dispatch = job?.dispatch;
  const active = job?.status === 'queued' || job?.status === 'running';
  useEffect(() => {
    if (!active || busy || dispatch?.needsAttention) return;
    const timer = window.setTimeout(() => void load(), 10_000);
    return () => window.clearTimeout(timer);
  }, [active, busy, dispatch?.needsAttention, snapshot, load]);

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
        if (
          !canPromote ||
          confirmation !== confirmationScope ||
          !approval?.tuple ||
          approval.decision !== 'approved'
        )
          return;
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
      setFailure(supportError(failure));
      setError('The action could not be confirmed. Check status or copy support details.');
    } finally {
      await load();
      acting.current = false;
      setBusy(false);
      setConfirmation(null);
      heading.current?.focus();
    }
  };
  const canPromote =
    stagingReady &&
    snapshot?.enabled &&
    !snapshot.busy &&
    !active &&
    approval?.decision === 'approved' &&
    approval.tuple &&
    'publicationProtocol' in approval.tuple &&
    approval.tuple.publicationProtocol === 2 &&
    job?.approvalId !== approval.id;
  const queued = job?.status === 'queued' && dispatch?.reserved === false;

  const confirmationScope = JSON.stringify([
    draftId,
    approval?.id,
    approval?.tuple,
    destination?.origin,
  ]);
  const sourceOrigin =
    stagingOrigin ??
    (destination?.repository === 'pointsite-canary'
      ? 'https://staging-canary.pointatx.org'
      : 'https://staging.pointatx.org');
  const verified =
    job?.status === 'succeeded' &&
    job.evidence.verificationStatus === 'passed' &&
    job.evidence.artifactDigest === job.artifactDigest;
  const currentVerified = verified && stagingReady && job?.approvalId === approval?.id;
  const failed =
    !verified &&
    (Boolean(error || failure || dispatch?.needsAttention) ||
      Boolean(job && !active) ||
      Boolean(
        dispatch?.actions?.jobs?.some(
          (item) => item.conclusion && !['success', 'skipped', 'neutral'].includes(item.conclusion),
        ),
      ));
  const showRecovery = failed || !dispatch?.actions || Boolean(dispatch.actions.unavailable);
  usePublishingSupport('Public website', { ...snapshot, error: failure });
  const showForward = stagingReady || active || failed;
  return (
    <>
      {showForward ? (
        <section className="publish-next-action" aria-labelledby="production-heading">
          <h3 id="production-heading" tabIndex={-1} ref={heading}>
            {currentVerified
              ? `Congratulations! Your site is live in ${label}.`
              : active
                ? `Publishing to ${label}`
                : `Publish to ${label}`}
          </h3>
          {snapshot?.enabled ? (
            <ol
              className="publish-steps publish-steps--production"
              aria-label={`${label} publishing progress`}
            >
              {['Publish', 'Verify', 'Live'].map((step, index) => {
                const current = currentVerified ? 3 : dispatch?.stage === 'verifying' ? 1 : 0;
                const state =
                  index < current ? 'complete' : index === current ? 'current' : 'upcoming';
                return (
                  <li
                    key={step}
                    data-state={state}
                    aria-current={state === 'current' ? 'step' : undefined}
                  >
                    <span className="publish-step-marker" aria-hidden="true">
                      {state === 'complete' ? '✓' : index + 1}
                    </span>
                    <strong>{step}</strong>
                  </li>
                );
              })}
            </ol>
          ) : null}
          {snapshot === undefined ? (
            <p role="status">Loading public site status…</p>
          ) : snapshot === null ? (
            <p role="status">
              Public site status is unavailable. Check status before taking another action.
            </p>
          ) : !snapshot.enabled ? (
            <p>Public site publishing is not enabled. Ask an Administrator to finish setup.</p>
          ) : (
            <>
              {currentVerified ? (
                <p role="status">Publication completed and verified.</p>
              ) : active ? (
                <p role="status">
                  {failed
                    ? 'Publication needs attention. Copy the support details if you need help.'
                    : 'Progress updates automatically. You can close this window and return later.'}
                </p>
              ) : snapshot.busy ? (
                <p>Another {label} publication needs to finish before publishing.</p>
              ) : canPromote ? (
                <p>Your accepted Staging version is ready for the public website.</p>
              ) : verified ? (
                <p>
                  The earlier accepted version was published. Publish and accept your current draft
                  on Staging to continue.
                </p>
              ) : job ? (
                <p role="status">
                  Publication needs attention. Check status or copy support details.
                </p>
              ) : (
                <p>Publish and accept this saved version on Staging first.</p>
              )}
              <PublicationProgress job={job} />
              {currentVerified ? (
                <a
                  className="button button--primary"
                  href={destination?.origin}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open {label}
                </a>
              ) : null}
              {canPromote ? (
                <button
                  className="button button--primary"
                  type="button"
                  disabled={busy}
                  onClick={(event) => {
                    event.currentTarget.focus();
                    setConfirmation(confirmationScope);
                  }}
                >
                  Publish to {label}
                </button>
              ) : null}
              {queued && dispatch.needsAttention ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy || !(Date.parse(dispatch.retryAt) <= Date.now())}
                  onClick={() => void act('retry')}
                >
                  Retry queued publication
                </button>
              ) : null}
              {showRecovery && dispatch?.canReconcileStopped ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => void act('reconcile')}
                >
                  Recover stopped publication
                </button>
              ) : null}
              {dispatch?.canRetryCaptured ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy || snapshot.busy}
                  onClick={() => void act('retry-captured')}
                >
                  Retry captured {label} version
                </button>
              ) : null}
              {showRecovery && dispatch?.canVerifyCompleted && !dispatch.canVerifyOutput ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => void act('verify-completed')}
                >
                  Verify completed {label} publication
                </button>
              ) : null}
              {showRecovery && job && dispatch?.canVerifyOutput ? (
                <PublicationVerification
                  key={job.id}
                  target="production"
                  label={label}
                  jobId={job.id}
                  dispatchAttempts={dispatch.attempts}
                  disabled={busy}
                  onRefresh={refreshVerification}
                />
              ) : null}
            </>
          )}
          {error ? <p role="alert">{error}</p> : null}
          {failed ? <CopyPublishingDetails /> : null}
          {snapshot?.enabled !== false && !currentVerified && (!active || failed) ? (
            <button
              className="button"
              type="button"
              disabled={busy || snapshot === undefined}
              onClick={() => {
                setFailure(null);
                setError(null);
                void load();
              }}
            >
              Check {label} status
            </button>
          ) : null}
        </section>
      ) : null}
      <PublishingDetails />
      {dangerActions || snapshot?.enabled ? (
        <details className="publish-danger">
          <summary>Danger zone</summary>
          {dangerActions}
          {queued ? (
            <details>
              <summary>Cancel this publication</summary>
              <p>
                This stops the queued publication before it starts. The current website stays
                online. Publishing later requires a new request.
              </p>
              <button
                className="button button--danger"
                type="button"
                disabled={busy}
                onClick={() => void act('cancel')}
              >
                Cancel queued {label} publication
              </button>
            </details>
          ) : null}
          {snapshot?.enabled ? (
            <ProductionRollback onRefresh={load} label={label} origin={destination?.origin} />
          ) : null}
        </details>
      ) : null}
      {confirmation !== null ? (
        <PublishingDialog
          title={`Publish to ${label}?`}
          busy={busy}
          onClose={() => setConfirmation(null)}
        >
          <p>
            This will take the current accepted website from{' '}
            <a href={sourceOrigin} target="_blank" rel="noreferrer">
              {sourceOrigin}
            </a>{' '}
            and publish it to{' '}
            <a href={destination?.origin} target="_blank" rel="noreferrer">
              {destination?.origin}
            </a>
            , replacing what visitors see there.
          </p>
          <p>
            Only the exact accepted Staging version is included. Newer draft edits stay in Builder.
            Builder checks that Staging has not changed before publishing.
          </p>
          <p>Builder will follow publication progress and confirm when the website is live.</p>
          {confirmation !== confirmationScope || !canPromote ? (
            <p role="alert">
              The accepted version changed. Close this confirmation and check status.
            </p>
          ) : null}
          <button
            className="button button--primary"
            type="button"
            disabled={busy || !canPromote || confirmation !== confirmationScope}
            onClick={() => void act('promote')}
          >
            Confirm publish to {label}
          </button>
        </PublishingDialog>
      ) : null}
    </>
  );
}
