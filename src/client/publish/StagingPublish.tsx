import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ClientApiError, type CandidateTuple } from '../api';
import { useEditor } from '../editor/EditorProvider';
import {
  getActionFailureGuidance,
  getPublishingNextStep,
  type ActionFailureGuidance,
  type PublishingRole,
} from './guidance';
import { deriveStagingWorkflow, type StagingWorkflowSnapshot } from './workflow';
import { ProductionPublish } from './ProductionPublish';
import { PublicationVerification } from './PublicationVerification';
import { Question } from '@phosphor-icons/react';
import { PublishingDialog } from './PublishingDialog';
import {
  PublishingSupport,
  PublishingDetails,
  CopyPublishingDetails,
  usePublishingSupport,
} from './PublishingSupport';
import { PublicationProgress } from './PublicationProgress';

const POLL_INTERVAL_MS = 10_000;
const steps = [
  ['Check', 'Check one exact saved version without changing Staging.'],
  ['Publish', 'Publish one candidate to publicly readable Staging.'],
  ['Verify', 'Follow required quality and deployment checks.'],
  ['Review', 'Open the public Staging website.'],
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
  return (
    <PublishingSupport>
      <StagingPublishingFlow role={role} />
    </PublishingSupport>
  );
}

function StagingPublishingFlow({ role }: { role: PublishingRole }) {
  const { draft, saveState } = useEditor();
  const [snapshot, setSnapshot] = useState<StagingWorkflowSnapshot | null | undefined>(undefined);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [monitoringPaused, setMonitoringPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<DisplayActionFailure | null>(null);
  const publishRequest = useRef<{ scope: string; key: string } | null>(null);
  const recoveryRequest = useRef<{ scope: string; key: string } | null>(null);
  const nextActionHeading = useRef<HTMLHeadingElement>(null);

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
  const refreshVerification = useCallback(
    async (focus = false) => {
      await loadWorkflow();
      if (focus) nextActionHeading.current?.focus();
    },
    [loadWorkflow],
  );

  useEffect(() => {
    setSnapshot(undefined);
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
      const restored = await loadWorkflow();
      setMonitoringPaused(!restored);
    } catch (error) {
      setActionError(actionFailure(error));
      setMonitoringPaused(true);
    } finally {
      setBusy(false);
    }
  }, [lifecycle.phase, loadWorkflow, snapshot?.job]);

  useEffect(() => {
    if (!lifecycle.shouldPoll || busy) return;
    const timer = window.setTimeout(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [busy, lifecycle.shouldPoll, refresh]);

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
      setMonitoringPaused(false);
      await loadWorkflow();
      nextActionHeading.current?.focus();
    } catch (error) {
      setActionError(actionFailure(error));
      await loadWorkflow();
    } finally {
      setBusy(false);
    }
  };

  const recoverQueued = async (
    action: 'retry' | 'cancel' | 'reconcile' | 'retry-captured' | 'verify-completed',
  ) => {
    const job = snapshot?.job;
    if (
      !job ||
      job.publicationProtocol !== 2 ||
      !job.dispatch ||
      !(
        (job.status === 'queued' && job.dispatch.reserved === false) ||
        (action === 'reconcile' && job.dispatch.canReconcileStopped === true) ||
        (action === 'retry-captured' && job.dispatch.canRetryCaptured === true) ||
        (action === 'verify-completed' && job.dispatch.canVerifyCompleted === true)
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
      setMonitoringPaused(false);
      await loadWorkflow();
      nextActionHeading.current?.focus();
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
      nextActionHeading.current?.focus();
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
      nextActionHeading.current?.focus();
    } catch (error) {
      setActionError(actionFailure(error));
      await loadWorkflow();
    } finally {
      setBusy(false);
    }
  };

  const job = snapshot?.job;
  const dispatch = job?.dispatch;
  const accepted = lifecycle.phase === 'accepted';
  const canRevoke =
    snapshot?.approval?.decision === 'approved' &&
    job?.publicationProtocol === 2 &&
    Boolean(snapshot.approval.tuple);
  const verified = job?.status === 'succeeded' && job.evidence.verificationStatus === 'passed';
  const failed =
    Boolean(actionError) ||
    (!verified &&
      (lifecycle.phase === 'failed' ||
        Boolean(dispatch?.needsAttention) ||
        Boolean(
          dispatch?.actions?.jobs?.some(
            (job) => job.conclusion && !['success', 'skipped', 'neutral'].includes(job.conclusion),
          ),
        )));
  const showRecovery = failed || !dispatch?.actions || Boolean(dispatch.actions.unavailable);
  usePublishingSupport('Staging', {
    draftId: draft.id,
    revisionId: draft.revision.id,
    revisionChecksum: draft.revision.checksum,
    sequence: draft.revision.sequence,
    ...snapshot,
    phase: lifecycle.phase,
    error: actionError,
  });
  const revokeAction = canRevoke ? (
    <button
      className="button button--danger"
      type="button"
      disabled={busy}
      onClick={(event) => {
        event.currentTarget.focus();
        setConfirmRevoke(true);
      }}
    >
      Revoke Staging acceptance
    </button>
  ) : null;
  return (
    <section className="publish-panel" aria-labelledby="publish-title">
      <div className="publish-heading">
        <div>
          <p className="eyebrow">Publishing</p>
          <h2 id="publish-title">Publish your site</h2>
        </div>
        <button
          className="button publish-help"
          type="button"
          aria-label="Publishing help"
          title="Publishing help"
          onClick={(event) => {
            event.currentTarget.focus();
            setHelpOpen(true);
          }}
        >
          <Question size={24} aria-hidden="true" />
        </button>
      </div>
      <p className="publish-draft-name">{draft.name}</p>

      {!accepted ? (
        <>
          <ol className="publish-steps" aria-label="Staging publishing progress">
            {steps.map(([label], index) => {
              const number = index + 1;
              const currentStep = dispatch?.stage === 'verifying' ? 3 : lifecycle.step;
              const state =
                number < currentStep ? 'complete' : number === currentStep ? 'current' : 'upcoming';
              return (
                <li
                  key={label}
                  data-state={state}
                  aria-current={state === 'current' ? 'step' : undefined}
                >
                  <span className="publish-step-marker" aria-hidden="true">
                    {state === 'complete' ? '✓' : number}
                  </span>
                  <strong>{label}</strong>
                </li>
              );
            })}
          </ol>
          <section className="publish-next-action" aria-labelledby="publish-next-action-title">
            <h3 id="publish-next-action-title" ref={nextActionHeading} tabIndex={-1}>
              {failed
                ? 'Staging needs attention'
                : lifecycle.phase === 'publishing'
                  ? 'Publishing to Staging'
                  : nextStep.title}
            </h3>
            <p>
              {failed
                ? 'Your draft is saved. Copy the support details if you need help.'
                : lifecycle.canPublish
                  ? 'Builder checks this saved version, then updates the Staging website. Staging is public.'
                  : lifecycle.phase === 'review-ready'
                    ? 'Review the website before accepting this version.'
                    : lifecycle.phase === 'waiting'
                      ? 'Another publication is using Staging. We will check again automatically.'
                      : lifecycle.shouldPoll
                        ? 'Progress updates automatically. You can close this window and return later.'
                        : nextStep.guidance}
            </p>
            {job?.publicationProtocol === 2 && job.revisionId !== draft.revision.id ? (
              <p>
                <strong>Newer draft edits are not included.</strong> This publication uses the saved
                version captured when it started.
              </p>
            ) : null}
            <PublicationProgress job={job} />
            {lifecycle.phase === 'review-ready' ? (
              <div className="publish-actions">
                <a className="button" href={snapshot?.reviewUrl} target="_blank" rel="noreferrer">
                  Open Staging for review
                </a>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={busy}
                  onClick={() => void accept()}
                >
                  {busy ? 'Accepting…' : 'Accept this Staging version'}
                </button>
              </div>
            ) : (
              <div className="publish-actions">
                {lifecycle.canPublish ? (
                  <button
                    className="button button--primary"
                    type="button"
                    disabled={busy || saveState !== 'saved'}
                    onClick={() => void publish()}
                  >
                    {busy ? 'Starting publication…' : 'Publish to Staging'}
                  </button>
                ) : null}
                {lifecycle.canRefresh && !lifecycle.shouldPoll ? (
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() => void refresh()}
                  >
                    {busy ? 'Checking…' : 'Check Staging status'}
                  </button>
                ) : null}
              </div>
            )}
            {job?.status === 'queued' && dispatch?.reserved === false && dispatch.needsAttention ? (
              <button
                className="button"
                type="button"
                disabled={busy || Date.parse(dispatch.retryAt) > Date.now()}
                onClick={() => void recoverQueued('retry')}
              >
                Retry queued publication
              </button>
            ) : null}
            {showRecovery && dispatch?.canReconcileStopped ? (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void recoverQueued('reconcile')}
              >
                Recover stopped publication
              </button>
            ) : null}
            {dispatch?.canRetryCaptured ? (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void recoverQueued('retry-captured')}
              >
                Retry captured candidate
              </button>
            ) : null}
            {showRecovery && dispatch?.canVerifyCompleted && !dispatch.canVerifyOutput ? (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void recoverQueued('verify-completed')}
              >
                Verify completed deployment
              </button>
            ) : null}
            {showRecovery && job?.publicationProtocol === 2 && dispatch?.canVerifyOutput ? (
              <PublicationVerification
                key={job.id}
                target="staging"
                jobId={job.id}
                dispatchAttempts={dispatch.attempts}
                disabled={busy}
                onRefresh={refreshVerification}
              />
            ) : null}
            {actionError ? (
              <p role="alert">
                {actionError.title}. {actionError.guidance}
              </p>
            ) : null}
            {failed ? <CopyPublishingDetails /> : null}
          </section>
        </>
      ) : (
        <section className="publish-accepted" aria-label="Accepted Staging version">
          <h3 ref={nextActionHeading} tabIndex={-1}>
            Staging accepted
          </h3>
          <a href={snapshot?.reviewUrl} target="_blank" rel="noreferrer">
            Open accepted Staging site
          </a>
        </section>
      )}
      {accepted && actionError ? (
        <div className="publish-action-error">
          <p role="alert">
            {actionError.title}. {actionError.guidance}
          </p>
          <CopyPublishingDetails />
        </div>
      ) : null}
      {role === 'administrator' ? (
        <ProductionPublish
          key={draft.id}
          draftId={draft.id}
          stagingOrigin={snapshot?.reviewUrl}
          stagingReady={accepted && saveState === 'saved'}
          approval={
            accepted && snapshot?.job?.id === snapshot?.approval?.publishJobId
              ? (snapshot?.approval ?? null)
              : null
          }
          dangerActions={revokeAction}
        />
      ) : (
        <>
          {accepted ? (
            <p>An Administrator can now publish this accepted version to the public website.</p>
          ) : null}
          <PublishingDetails />
          {revokeAction ? (
            <details className="publish-danger">
              <summary>Danger zone</summary>
              {revokeAction}
            </details>
          ) : null}
        </>
      )}
      {job?.status === 'queued' && dispatch?.reserved === false ? (
        <details className="publish-danger">
          <summary>Cancel this publication</summary>
          <p>This stops the queued publication before it starts. Your draft stays saved.</p>
          <button
            className="button button--danger"
            type="button"
            disabled={busy}
            onClick={() => void recoverQueued('cancel')}
          >
            Cancel queued publication
          </button>
        </details>
      ) : null}
      {helpOpen ? (
        <PublishingDialog title="Publishing help" onClose={() => setHelpOpen(false)}>
          <ol>
            {steps.map(([label, description]) => (
              <li key={label}>
                <strong>{label}.</strong> {description}
              </li>
            ))}
            <li>
              <strong>Publish to the public website.</strong> After Staging acceptance, an
              Administrator confirms the destination. Builder publishes the exact accepted version
              and checks the result automatically. No second acceptance is needed.
            </li>
          </ol>
          <p>
            New edits stay in the draft until you publish and accept them on Staging. Both Staging
            and the destination website are public.
          </p>
          <p>
            You can close this window during publication. Reopen it to see saved progress. If
            something fails, select Copy support details and paste the result into a message to your
            site maintainer.
          </p>
          <p>
            Danger zone contains restore and revoke actions. Each explains its effect before you
            confirm.
          </p>
        </PublishingDialog>
      ) : null}
      {confirmRevoke ? (
        <PublishingDialog
          title="Revoke Staging acceptance?"
          busy={busy}
          onClose={() => setConfirmRevoke(false)}
        >
          <p>
            This permanently records withdrawal of this acceptance. It prevents new publication
            using this decision. It does not remove the current Staging or public website, or undo a
            publication already authorized.
          </p>
          <p>
            To publish this version later, review and accept it again. The withdrawn decision cannot
            be restored.
          </p>
          <button
            className="button button--danger"
            type="button"
            disabled={busy}
            onClick={() => void revoke().then(() => setConfirmRevoke(false))}
          >
            Confirm revoke acceptance
          </button>
        </PublishingDialog>
      ) : null}
    </section>
  );
}
