import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ClientApiError } from '../api';
import type { PublicationVerificationState } from './workflow';

export function PublicationVerification({
  target,
  jobId,
  dispatchAttempts,
  onRefresh,
  disabled = false,
  label = target === 'staging' ? 'Staging' : 'Site Production',
}: {
  target: 'staging' | 'production';
  jobId: string;
  dispatchAttempts: number;
  onRefresh: (focus?: boolean) => Promise<unknown>;
  disabled?: boolean;
  label?: string;
}) {
  const [verification, setVerification] = useState<PublicationVerificationState | null>();
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ scope: string; key: string } | null>(null);
  const reading = useRef({ generation: 0, mounted: true });
  const acting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(async () => {
    if (!reading.current.mounted) return;
    const generation = ++reading.current.generation;
    try {
      const result = await api.getPublicationVerification(target, jobId);
      if (generation === reading.current.generation) setVerification(result.verification);
    } catch {
      if (generation === reading.current.generation) {
        setVerification(undefined);
        setError('Verification status is unavailable. Check status before trying again.');
      }
    }
  }, [target, jobId]);
  useEffect(() => {
    const state = reading.current;
    state.mounted = true;
    setVerification(undefined);
    setError(null);
    void load();
    return () => {
      state.mounted = false;
      ++state.generation;
    };
  }, [load]);
  useEffect(() => {
    if (
      !verification ||
      !['queued', 'running'].includes(verification.status) ||
      busy ||
      verification.needsAttention
    )
      return;
    const remaining = Date.parse(verification.requestedAt) + 15 * 60_000 - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setPaused(true);
      return;
    }
    setPaused(false);
    const timer = window.setTimeout(() => void load(), Math.min(10_000, remaining));
    return () => window.clearTimeout(timer);
  }, [verification, busy, load]);
  useEffect(() => {
    if (verification?.status === 'passed') void onRefresh();
  }, [verification?.status, onRefresh]);

  const act = async (action: 'capture' | 'retry' | 'reconcile') => {
    if (acting.current || disabled || verification === undefined) return;
    const scope = JSON.stringify([
      target,
      jobId,
      action,
      dispatchAttempts,
      verification?.id,
      verification?.dispatchAttempts,
    ]);
    if (request.current?.scope !== scope) request.current = { scope, key: crypto.randomUUID() };
    acting.current = true;
    ++reading.current.generation;
    setBusy(true);
    setError(null);
    let completed = false;
    try {
      if (action === 'capture')
        await api.capturePublicationVerification(
          target,
          jobId,
          dispatchAttempts,
          request.current.key,
        );
      else if (verification)
        await api.recoverPublicationVerification(
          target,
          jobId,
          verification.id,
          action,
          verification.dispatchAttempts,
          request.current.key,
        );
      request.current = null;
      await onRefresh(true);
      completed = true;
    } catch (failure) {
      setError(
        failure instanceof ClientApiError && failure.code === 'PUBLICATION_RUN_NOT_TERMINAL'
          ? 'The cloud workflow is still running. Wait for it to stop, then check status.'
          : 'Verification could not be confirmed. Check status before trying again.',
      );
    } finally {
      await load();
      acting.current = false;
      setBusy(false);
      if (!completed || action !== 'reconcile') heading.current?.focus();
    }
  };
  const active = verification?.status === 'queued' || verification?.status === 'running';
  return (
    <section className="publish-next-action" aria-labelledby={`${target}-verification-heading`}>
      <h3 id={`${target}-verification-heading`} tabIndex={-1} ref={heading}>
        {label} verification
      </h3>
      <p>
        Check existing website files after the publication workflow stops. This does not publish
        again.
      </p>
      <p role="status">
        {verification === undefined
          ? error
            ? 'Verification status is unavailable.'
            : 'Reading verification status…'
          : !verification
            ? 'No recovery verification is recorded.'
            : verification.status === 'passed'
              ? 'Existing publication verified.'
              : verification.reported
                ? 'Verification finished checking files. Its completion needs confirmation.'
                : verification.status === 'queued'
                  ? 'Verification is queued.'
                  : verification.status === 'running'
                    ? 'Verification is checking the existing publication.'
                    : 'Verification needs another attempt.'}
      </p>
      {paused && active ? (
        <p>Automatic verification monitoring paused. Check status to read the latest progress.</p>
      ) : null}
      {verification?.workflowUrl ? (
        <a href={verification.workflowUrl} target="_blank" rel="noreferrer">
          Verification cloud progress
        </a>
      ) : null}
      {verification === null || (verification?.status === 'failed' && verification.attempt < 3) ? (
        <button
          className="button"
          type="button"
          disabled={busy || disabled}
          onClick={() => void act('capture')}
        >
          Verify existing publication
        </button>
      ) : null}
      {active && verification?.reported ? (
        <button
          className="button"
          type="button"
          disabled={busy || disabled}
          onClick={() => void act('reconcile')}
        >
          Finish verification
        </button>
      ) : null}
      {active &&
      verification &&
      !verification.reported &&
      verification.attempt < 3 &&
      (verification.status === 'running' || verification.needsAttention) ? (
        <button
          className="button"
          type="button"
          disabled={busy || disabled}
          onClick={() => void act('retry')}
        >
          Retry stopped verification
        </button>
      ) : null}
      {verification &&
      verification.attempt >= 3 &&
      verification.status !== 'passed' &&
      !verification.reported ? (
        <p>
          The verification attempt limit is reached. Ask a site maintainer to review cloud progress.
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <button
        className="button"
        type="button"
        disabled={busy || disabled}
        onClick={() => {
          setError(null);
          void load();
        }}
      >
        Check verification status
      </button>
    </section>
  );
}
