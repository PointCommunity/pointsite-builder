import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { StagingAcceptanceSummary } from './workflow';
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
import { usePublicationStatus } from './usePublicationStatus';

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
  const read = useCallback(() => api.getProductionWorkflow(draftId), [draftId]);
  const status = usePublicationStatus(draftId, read);
  const { snapshot, load } = status;
  const [actionBusy, setBusy] = useState(false);
  const busy = actionBusy || status.checking;
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof supportError> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ scope: string; key: string } | null>(null);
  const acting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const refreshVerification = useCallback(
    async (focus = false) => {
      await load(true);
      if (focus) heading.current?.focus();
    },
    [load],
  );
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
    if (!active || busy || status.paused) return;
    const timer = window.setTimeout(() => void load(), 10_000);
    return () => window.clearTimeout(timer);
  }, [active, busy, status.paused, snapshot, load]);

  const act = async (action: 'promote' | RecoveryAction) => {
    if (acting.current || busy || status.stale || !snapshot?.enabled) return;
    const scope =
      action === 'promote'
        ? JSON.stringify([draftId, approval?.id, approval?.tuple])
        : JSON.stringify([job?.id, action, dispatch?.attempts, dispatch?.retryAt]);
    if (request.current?.scope !== scope) request.current = { scope, key: crypto.randomUUID() };
    acting.current = true;
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
      await load(true);
      acting.current = false;
      setBusy(false);
      setConfirmation(null);
      heading.current?.focus();
    }
  };
  const canPromote =
    !status.stale &&
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
    (Boolean(error || failure || status.error || dispatch?.needsAttention) ||
      Boolean(job && !active) ||
      Boolean(
        dispatch?.actions?.jobs?.some(
          (item) => item.conclusion && !['success', 'skipped', 'neutral'].includes(item.conclusion),
        ),
      ));
  const showRecovery =
    failed ||
    !dispatch?.actions ||
    Boolean(dispatch.actions.unavailable) ||
    dispatch.actions.run?.status === 'completed';
  usePublishingSupport('Public website', { ...snapshot, error: failure });
  const showForward = stagingReady || active || failed || Boolean(status.error);
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
                    : status.paused
                      ? 'Automatic monitoring paused. Check status to resume.'
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
              <PublicationProgress
                job={job}
                checkedAt={status.checkedAt}
                stale={status.stale}
                paused={status.paused}
              />
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
              {queued &&
              (dispatch.canRetryQueued ?? dispatch.attempts >= 6) &&
              dispatch.failureCode !== 'PUBLISH_BASE_CHANGED' ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy || status.stale || !(Date.parse(dispatch.retryAt) <= Date.now())}
                  onClick={() => void act('retry')}
                >
                  Retry queued publication
                </button>
              ) : null}
              {showRecovery && dispatch?.canReconcileStopped ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy || status.stale}
                  onClick={() => void act('reconcile')}
                >
                  Recover stopped publication
                </button>
              ) : null}
              {dispatch?.canRetryCaptured ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy || status.stale || snapshot.busy}
                  onClick={() => void act('retry-captured')}
                >
                  Retry captured {label} version
                </button>
              ) : null}
              {showRecovery && dispatch?.canVerifyCompleted && !dispatch.canVerifyOutput ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy || status.stale}
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
                  disabled={busy || status.stale}
                  onRefresh={refreshVerification}
                />
              ) : null}
            </>
          )}
          {error ? <p role="alert">{error}</p> : null}
          {status.error ? (
            <p role="alert">
              Status could not be checked. The last known publication is saved. Check status to try
              again.
            </p>
          ) : null}
          {failed ? <CopyPublishingDetails /> : null}
          {snapshot?.enabled !== false ? (
            <button
              className="button"
              type="button"
              disabled={busy || snapshot === undefined}
              onClick={() => {
                setFailure(null);
                setError(null);
                void load(true).then(() => heading.current?.focus());
              }}
            >
              Check {label} status
            </button>
          ) : null}
          {queued ? (
            <div className="publish-danger">
              <p>
                Cancel this queued attempt before deliberately publishing a fresh accepted version.
                The current website stays online.
              </p>
              <button
                className="button button--danger"
                type="button"
                disabled={busy || status.stale}
                onClick={() => void act('cancel')}
              >
                Cancel queued {label} publication
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      <PublishingDetails />
      {dangerActions || snapshot?.enabled ? (
        <details className="publish-danger">
          <summary>Danger zone</summary>
          {dangerActions}
          {snapshot?.enabled ? (
            <ProductionRollback
              onRefresh={async () => {
                await load(true);
              }}
              label={label}
              origin={destination?.origin}
            />
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
