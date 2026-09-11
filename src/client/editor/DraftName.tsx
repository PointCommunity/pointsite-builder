import { useCallback, useEffect, useId, useRef, useState } from 'react';

export function DraftName({
  name,
  editable,
  onRename,
}: {
  name: string;
  editable: boolean;
  onRename: (name: string) => Promise<void>;
}) {
  const id = useId();
  const restoreFocus = useRef(false);
  const focusButton = useCallback((element: HTMLButtonElement | null) => {
    if (element && restoreFocus.current) {
      element.focus();
      restoreFocus.current = false;
    }
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const selectInput = useCallback((element: HTMLInputElement | null) => {
    input.current = element;
    element?.focus();
    element?.select();
  }, []);
  const saving = useRef(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (error && !pending) input.current?.focus();
  }, [error, pending]);
  const begin = () => {
    if (!editable) return;
    setValue(name);
    setError('');
    setStatus('');
    setEditing(true);
  };
  const finish = () => {
    restoreFocus.current = true;
    setEditing(false);
    setError('');
  };
  const cancel = () => {
    if (saving.current) return;
    setStatus('Rename canceled.');
    finish();
  };
  const save = async () => {
    if (saving.current || !editable) return;
    const next = value.trim();
    if (!next || next.length > 100) {
      setError('Enter a draft name with 1–100 characters.');
      input.current?.focus();
      return;
    }
    if (next === name) {
      setStatus('Draft name unchanged.');
      finish();
      return;
    }
    saving.current = true;
    setPending(true);
    setError('');
    setStatus('Saving draft name…');
    try {
      await onRename(next);
      setStatus('Draft name saved.');
      finish();
    } catch {
      setStatus('');
      setError('The draft name could not be saved. Try again or cancel to keep the original name.');
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return (
    <div className="draft-name">
      {editing && editable ? (
        <form
          className="draft-name__form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            }
          }}
        >
          <label htmlFor={id}>Draft name</label>
          <input
            id={id}
            ref={selectInput}
            value={value}
            disabled={pending}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
            onChange={(event) => {
              setValue(event.target.value);
              setError('');
            }}
          />
          <div className="button-row">
            <button className="button" type="submit" disabled={pending}>
              Save name
            </button>
            <button className="button" type="button" disabled={pending} onClick={cancel}>
              Cancel
            </button>
          </div>
          <span id={`${id}-help`}>Enter saves. Escape cancels. Maximum 100 characters.</span>
          {error ? (
            <p id={`${id}-error`} role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="draft-name__heading">
          <h1 className="editor-title" onDoubleClick={editable ? begin : undefined}>
            {name}
          </h1>
          {editable ? (
            <button ref={focusButton} className="button" type="button" onClick={begin}>
              Rename draft
            </button>
          ) : null}
        </div>
      )}
      <span role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
