import { useEffect, useId, useRef, useState } from 'react';
import type { FeedbackAvailability, FeedbackScreen } from '../../shared/feedback';
import { api } from '../api';
import { clearFeedbackWorkspace } from './workspace';

export function FeedbackButton({
  screen,
  beforeLaunch,
}: {
  screen: FeedbackScreen;
  beforeLaunch?: () => Promise<void>;
}) {
  const [mode, setMode] = useState<FeedbackAvailability['mode']>('disabled');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const prepare = useRef(beforeLaunch);
  const currentScreen = useRef(screen);
  useEffect(() => {
    prepare.current = beforeLaunch;
    currentScreen.current = screen;
  }, [beforeLaunch, screen]);
  const description = useId();
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void api
        .feedbackAvailability()
        .then((next) => {
          if (active)
            setMode(next.mode === 'pilot' || next.mode === 'production' ? next.mode : 'disabled');
        })
        .catch(() => {
          if (active) setMode('disabled');
        });
    };
    refresh();
    const restore = () => {
      setBusy(false);
      refresh();
    };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', restore);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', restore);
    };
  }, []);
  if (mode === 'disabled') return null;
  const launch = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await prepare.current?.();
      const result = await api.launchFeedback(screen);
      if (currentScreen.current !== screen) throw new Error('Screen changed');
      const expected =
        mode === 'pilot'
          ? 'https://pointview-canary.eaglepass.io/launch'
          : 'https://pointview.eaglepass.io/launch';
      if (
        result.action !== expected ||
        typeof result.launchToken !== 'string' ||
        result.launchToken.length > 5000
      )
        throw new Error('Invalid launch');
      // A second check catches edits made while the signing request was in flight.
      await prepare.current?.();
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = result.action;
      form.hidden = true;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'launch_token';
      input.value = result.launchToken;
      form.appendChild(input);
      document.body.appendChild(form);
      try {
        form.submit();
      } finally {
        input.value = '';
        form.remove();
      }
    } catch {
      clearFeedbackWorkspace();
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <div className="feedback-control">
      <button
        className="button"
        type="button"
        disabled={busy}
        aria-describedby={description}
        onClick={() => void launch()}
      >
        {busy ? 'Opening feedback…' : mode === 'pilot' ? 'Send feedback (test)' : 'Send feedback'}
      </button>
      <span id={description} className="feedback-guidance">
        Includes your screen context. Add screenshots only if you choose.
      </span>
      {failed ? (
        <p role="alert">
          Feedback could not be opened. Your draft is safe. Wait for autosave, then try again.
        </p>
      ) : null}
    </div>
  );
}
