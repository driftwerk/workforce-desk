import { useState, type ReactNode } from "react";
import { CloseButton, Dialog } from "./Dialog";
import { plainError } from "./plainError";

/** Asks before something that can't be undone: `action` runs on the red
 *  button, and the dialog stays open, saying why, if it fails. */
export function Confirm({
  title,
  children,
  action,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  /** The red button's label, e.g. "Delete room". */
  action: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setProblem(plainError(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              {title}
            </h1>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-body confirm-body">{children}</div>
      <footer className="dialog-foot">
        <span className="dialog-foot-note state-blocked">{problem}</span>
        <button type="button" className="btn btn-ghost" data-autofocus onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void go()}>
          {busy ? `${action}…` : action}
        </button>
      </footer>
    </Dialog>
  );
}
