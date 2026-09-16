import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { RollbackSelection, RollbackSnapshot } from './workflow';

export function ProductionRollback({
  onRefresh,
  label = 'Site Production',
}: {
  onRefresh: () => Promise<void>;
  label?: string;
}) {
  const [snapshot, setSnapshot] = useState<RollbackSnapshot | null>();
  const [selected, setSelected] = useState('');
  const [prepared, setPrepared] = useState<{ selection: RollbackSelection; key: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reading = useRef(0),
    acting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(async () => {
    const generation = ++reading.current;
    try {
      const value = await api.getRollback();
      if (generation === reading.current) setSnapshot(value);
    } catch {
      if (generation === reading.current) setSnapshot(null);
    }
  }, []);
  useEffect(() => {
    const generation = reading;
    void load();
    return () => {
      ++generation.current;
    };
  }, [load]);
  const job = snapshot?.enabled ? snapshot.job : null;
  const active = job?.status === 'queued' || job?.status === 'running';
  const remaining = job ? Date.parse(job.requestedAt) + 15 * 60_000 - Date.now() : 0;
  useEffect(() => {
    if (!active || busy || remaining <= 0 || job.attempts >= 6) return;
    const timer = window.setTimeout(() => void load(), Math.min(10_000, remaining));
    return () => window.clearTimeout(timer);
  }, [active, busy, remaining, job, load]);
  const act = async (action: 'prepare' | 'restore' | 'cancel' | 'verify') => {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError('');
    ++reading.current;
    try {
      if (action === 'prepare') {
        if (!selected) return;
        const state = await api.prepareRollback();
        setPrepared({
          selection: { ...state, sourceReleaseId: selected },
          key: crypto.randomUUID(),
        });
      } else if (action === 'restore') {
        if (!prepared) return;
        await api.rollbackProduction(prepared.selection, prepared.key);
        setPrepared(null);
      } else if (job) {
        await api.recoverRollback(job.id, action);
        setPrepared(null);
      }
    } catch {
      setError(
        'The action could not be confirmed. Check rollback status before trying again. Running cloud operations must finish before recovery.',
      );
    } finally {
      await load();
      await onRefresh();
      acting.current = false;
      setBusy(false);
      heading.current?.focus();
    }
  };
  if (snapshot?.enabled === false) return null;
  return (
    <section aria-labelledby="production-rollback-heading">
      <h3 id="production-rollback-heading" tabIndex={-1} ref={heading}>
        Restore a {label} release
      </h3>
      {snapshot === undefined ? (
        <p role="status">Loading retained releases…</p>
      ) : !snapshot ? (
        <p role="status">Rollback status is unavailable.</p>
      ) : (
        <>
          <p>
            Restore a previously verified public website. Drafts and their saved history stay
            available.
          </p>
          {job ? (
            <p role="status">
              {job.status === 'succeeded'
                ? 'Restored website verified.'
                : job.status === 'cancelled'
                  ? 'Rollback cancelled. Any existing public deployment remains in place.'
                  : remaining <= 0 || job.attempts >= 6
                    ? 'Rollback needs attention. Check cloud progress and reconcile the stopped run.'
                    : 'The captured rollback continues in the cloud after you close Builder.'}
            </p>
          ) : null}
          {job?.workflowUrl ? (
            <a href={job.workflowUrl} target="_blank" rel="noreferrer">
              Rollback cloud progress
            </a>
          ) : null}
          {active ? (
            <>
              {job.canVerify ? (
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => void act('verify')}
                >
                  Verify completed rollback
                </button>
              ) : null}
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void act('cancel')}
              >
                Cancel queued or stopped rollback
              </button>
            </>
          ) : (
            <>
              <label htmlFor="rollback-release">Verified release</label>
              <select
                id="rollback-release"
                value={selected}
                disabled={busy}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setPrepared(null);
                }}
              >
                <option value="">Choose a release</option>
                {snapshot.releases.map((release) => (
                  <option key={release.id} value={release.id}>
                    {release.kind === 'baseline' ? 'Original website' : 'Verified release'} —{' '}
                    {new Date(release.verifiedAt).toLocaleString()}
                  </option>
                ))}
              </select>
              {snapshot.publicationJobId ? (
                <p>
                  A {label} publication holds the lock. Restore can proceed only after its cloud run
                  has stopped.
                </p>
              ) : null}
              {prepared ? (
                <>
                  <p>
                    This replaces the public website with the selected release. Continue only when
                    that is the version you want visitors to see.
                  </p>
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() => void act('restore')}
                  >
                    Restore selected release to {label}
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() => setPrepared(null)}
                  >
                    Discard restore selection
                  </button>
                </>
              ) : (
                <button
                  className="button"
                  type="button"
                  disabled={busy || !selected}
                  onClick={() => void act('prepare')}
                >
                  Prepare selected restore
                </button>
              )}
            </>
          )}
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
      <button className="button" type="button" disabled={busy} onClick={() => void load()}>
        Check rollback status
      </button>
    </section>
  );
}
