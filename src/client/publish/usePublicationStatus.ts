import { useCallback, useEffect, useRef, useState } from 'react';

/** One read per view; stale reads never replace another draft or erase a known job. */
export function usePublicationStatus<T>(scope: string, read: () => Promise<T>) {
  const [state, setState] = useState<{
    scope: string;
    snapshot?: T | null;
    checkedAt?: string;
    error?: unknown;
    checking: boolean;
    paused: boolean;
  }>({ scope, checking: true, paused: false });
  const current = useRef({
    scope,
    generation: 0,
    pending: null as Promise<T | null> | null,
    until: Date.now() + 15 * 60_000,
  });
  const load = useCallback(
    (manual = false): Promise<T | null> => {
      const run = current.current;
      if (run.scope !== scope) return Promise.resolve(null);
      if (run.pending) return run.pending;
      if (manual) run.until = Date.now() + 15 * 60_000;
      if (Date.now() >= run.until) {
        setState((previous) => ({ ...previous, paused: true }));
        return Promise.resolve(null);
      }
      const generation = ++run.generation;
      setState((previous) => ({ ...previous, checking: true }));
      run.pending = (async () => {
        try {
          const snapshot = await Promise.resolve().then(read);
          if (current.current !== run || generation !== run.generation) return null;
          setState({
            scope,
            snapshot,
            checkedAt: new Date().toISOString(),
            checking: false,
            paused: false,
          });
          return snapshot;
        } catch (error) {
          if (current.current === run && generation === run.generation)
            setState((previous) => ({
              ...previous,
              snapshot: previous.snapshot ?? null,
              error,
              checking: false,
              paused: true,
            }));
          return null;
        } finally {
          run.pending = null;
        }
      })();
      return run.pending;
    },
    [read, scope],
  );
  useEffect(() => {
    const run = {
      scope,
      generation: 0,
      pending: null as Promise<T | null> | null,
      until: Date.now() + 15 * 60_000,
    };
    current.current = run;
    setState({ scope, checking: true, paused: false });
    void load();
    return () => {
      ++run.generation;
    };
  }, [scope, load]);
  return {
    snapshot: state.scope === scope ? state.snapshot : undefined,
    checkedAt: state.scope === scope ? state.checkedAt : undefined,
    stale: state.scope === scope && Boolean(state.error),
    error: state.scope === scope ? state.error : undefined,
    checking: state.scope !== scope || state.checking,
    paused: state.scope === scope && state.paused,
    load,
  };
}
