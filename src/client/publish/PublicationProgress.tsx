import type { StagingWorkflowJob } from './workflow';

export function PublicationProgress({
  job,
}: {
  job?: Pick<StagingWorkflowJob, 'status' | 'dispatch'> | null;
}) {
  if (!job || !['queued', 'running'].includes(job.status)) return null;
  const failed = job.dispatch?.actions?.jobs?.some(
    (item) => item.conclusion && !['success', 'skipped', 'neutral'].includes(item.conclusion),
  );
  const titles: Record<string, string> = {
    queued: 'Waiting to start',
    building: 'Building your website',
    preparing: 'Preparing website files',
    deploying: 'Updating the website',
    verifying: 'Checking the published website',
  };
  return (
    <div className="publication-progress" role="status" aria-live="polite">
      {!failed ? <progress aria-label="Publication in progress" /> : null}
      <strong>
        {failed
          ? 'A publishing check stopped. Support details include the failed steps.'
          : (titles[job.dispatch?.stage ?? ''] ?? 'Publication is running')}
      </strong>
      {job.dispatch?.actions?.unavailable ? (
        <p>
          Detailed progress is temporarily unavailable. Builder is still checking publication
          status.
        </p>
      ) : null}
    </div>
  );
}
