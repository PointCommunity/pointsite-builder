import { useEffect, useId, useRef, type ReactNode } from 'react';

export function PublishingDialog({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      element?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="confirmation-dialog publishing-dialog"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={id}>{title}</h2>
      {children}
      <button className="button" autoFocus type="button" disabled={busy} onClick={onClose}>
        Close
      </button>
    </dialog>
  );
}
