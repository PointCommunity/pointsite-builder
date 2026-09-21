import type { StagingWorkflowJob } from './workflow';
import { usePublishingSupport } from './PublishingSupport';

export interface ProgressProps {
  job?: Pick<StagingWorkflowJob, 'status' | 'dispatch'> | null;
  checkedAt?: string;
  stale?: boolean;
  paused?: boolean;
  label?: string;
}

const milestones = [
  ['queued', 'Queue'],
  ['building', 'Build'],
  ['preparing', 'Prepare'],
  ['deploying', 'Publish'],
  ['verifying', 'Check'],
];

export function PublicationProgress({
  job,
  checkedAt,
  stale = false,
  paused = false,
  label = 'Staging',
  hidden = false,
}: ProgressProps & { hidden?: boolean }) {
  usePublishingSupport(`${label} progress`, { kind: 'progress', job, checkedAt, stale, paused });
  if (!job || hidden) return null;
  const dispatch = job.dispatch;
  const actions = dispatch?.actions;
  const failed = job.dispatch?.actions?.jobs?.some(
    (item) => item.conclusion && !['success', 'skipped', 'neutral'].includes(item.conclusion),
  );
  const titles: Record<string, string> = {
    queued: 'Publication is queued',
    building: 'Building your website',
    preparing: 'Preparing website files',
    deploying: 'Updating the website',
    verifying: 'Checking the published website',
  };
  const stopped = actions?.run?.status === 'completed';
  const unconfirmed =
    dispatch?.startUnconfirmed ??
    (job.status === 'queued' && dispatch?.reserved === false && !actions?.run);
  const active = ['queued', 'running'].includes(job.status);
  const title = stale
    ? 'Status check unavailable'
    : dispatch?.cancelling
      ? 'Cancelling publication'
      : !active
        ? job.status === 'succeeded'
          ? 'Publication completed'
          : job.status === 'cancelled'
            ? 'Publication cancelled'
            : 'Publication failed'
        : stopped || failed
          ? actions?.run?.conclusion === 'cancelled'
            ? 'Publishing run cancelled'
            : actions?.run?.conclusion === 'success'
              ? 'Execution finished; publication not confirmed'
              : 'Publishing run stopped'
          : actions?.unavailable
            ? 'Current execution status unavailable'
            : unconfirmed
              ? 'Start not confirmed'
              : actions?.run && ['queued', 'waiting', 'pending'].includes(actions.run.status)
                ? 'Publication is queued'
                : actions?.run?.status === 'in_progress' && dispatch?.stage === 'queued'
                  ? 'Execution started; waiting for Builder confirmation'
                  : (titles[dispatch?.stage ?? ''] ?? 'Publication is running');
  const completed =
    job.status === 'succeeded'
      ? milestones.length
      : Math.max(
          0,
          milestones.findIndex(([stage]) => stage === dispatch?.stage),
        );
  return (
    <div className="publication-progress">
      <strong role="status" aria-live="polite">
        {title}
      </strong>
      <div
        className="publication-progress__bar"
        role="progressbar"
        aria-label={`${label} publication progress`}
        aria-valuemin={0}
        aria-valuemax={milestones.length}
        aria-valuenow={completed}
        aria-valuetext={`${title}. ${completed} of ${milestones.length} steps complete.`}
      >
        <span style={{ width: `${(completed / milestones.length) * 100}%` }} />
      </div>
      <ol className="publication-progress__steps" aria-label="Publication steps">
        {milestones.map(([stage, name], index) => (
          <li
            key={stage}
            data-state={
              index < completed ? 'complete' : index === completed ? 'current' : 'waiting'
            }
            aria-current={
              index === completed && active && !dispatch?.cancelling ? 'step' : undefined
            }
          >
            <span aria-hidden="true">{index < completed ? '✓' : index + 1}</span>
            <span>{name}</span>
            <span className="visually-hidden">
              {index < completed ? ' complete' : index === completed ? ' current step' : ' waiting'}
            </span>
          </li>
        ))}
      </ol>
      {dispatch?.cancelling ? (
        <p>
          {dispatch.cancellationError
            ? 'Cancellation needs another check. Retry cancellation below.'
            : 'Stopping the publishing run. You can close this window.'}
        </p>
      ) : stale ? (
        <p>Showing saved progress. Check status to reconnect.</p>
      ) : paused ? (
        <p>Automatic monitoring paused. Check status to resume.</p>
      ) : null}
    </div>
  );
}

export function PublicationDiagnostics({ job, checkedAt, stale, paused }: ProgressProps) {
  if (!job) return null;
  const dispatch = job.dispatch;
  const actions = dispatch?.actions;
  const active = ['queued', 'running'].includes(job.status);
  const stopped = actions?.run?.status === 'completed';
  const failed = actions?.jobs?.some(
    (item) => item.conclusion && !['success', 'skipped', 'neutral'].includes(item.conclusion),
  );
  const unconfirmed =
    dispatch?.startUnconfirmed ??
    (job.status === 'queued' && dispatch?.reserved === false && !actions?.run);
  return (
    <div>
      {dispatch?.retryBlocker ? <p>{dispatch.retryBlocker}</p> : null}
      {checkedAt ? (
        <p>
          Last successful status check:{' '}
          <time dateTime={checkedAt}>{new Date(checkedAt).toLocaleString()}</time>.
        </p>
      ) : null}
      {actions?.lastSuccessfulCheckAt ? (
        <p>
          Execution checked:{' '}
          <time dateTime={actions.lastSuccessfulCheckAt}>
            {new Date(actions.lastSuccessfulCheckAt).toLocaleString()}
          </time>
          .
        </p>
      ) : null}
      {stale ? (
        <p>Showing the last known publication. Check status before taking another action.</p>
      ) : null}
      {paused ? <p>Automatic monitoring paused. Check status to resume.</p> : null}
      {active && unconfirmed ? (
        <p>
          The captured version is saved, but execution has not been confirmed. Check status or
          cancel this queued attempt.
        </p>
      ) : null}
      {active && (stopped || failed) ? (
        <p>
          The execution stopped. Use the available recovery action below; a successful run alone
          does not confirm publication.
        </p>
      ) : null}
      {active && actions?.unavailable ? (
        <p>Fresh execution details are unavailable. The last known publication remains saved.</p>
      ) : null}
      {active &&
      actions?.retryAt &&
      Date.parse(actions.retryAt) > Date.parse(checkedAt ?? dispatch?.checkedAt ?? '') ? (
        <p>
          Next execution check available after {new Date(actions.retryAt).toLocaleTimeString()}.
          Check status still reads Builder's saved state.
        </p>
      ) : null}
      {active &&
      dispatch?.reserved === false &&
      Date.parse(dispatch.retryAt) > Date.parse(checkedAt ?? dispatch.checkedAt ?? '') ? (
        <p>Dispatch retry available after {new Date(dispatch.retryAt).toLocaleTimeString()}.</p>
      ) : null}
      {active && !stale && dispatch?.failureCode === 'PUBLISH_BASE_CHANGED' ? (
        <p>The destination changed. Cancel this attempt, then check and publish a fresh version.</p>
      ) : null}
      {active &&
      (stopped || unconfirmed || actions?.unavailable) &&
      dispatch?.reserved !== false &&
      !dispatch?.canReconcileStopped &&
      !dispatch?.canVerifyCompleted &&
      !dispatch?.canVerifyOutput ? (
        <p>
          No safe cancellation or retry is currently available. Deployment evidence must be checked
          before recovery. Check status or contact an Administrator.
        </p>
      ) : null}
    </div>
  );
}
