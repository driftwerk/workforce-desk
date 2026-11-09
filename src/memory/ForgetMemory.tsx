import { useRef, useState } from "react";
import type { Engine, SessionMemory } from "../hub/types";
import { ENGINE_TITLE } from "../engines/engines";
import { Confirm } from "../ui/Confirm";
import { CloseButton, Dialog } from "../ui/Dialog";
import { count, noteCount } from "./words";

/** What the dialog says of how long search may still find it: Desk
 *  Memory's search index keeps what it deletes for up to a day (§13 D5). */
export const RESTORE_WINDOW = "Desk Memory's search may keep a copy for up to 24 hours before it's gone for good.";

/** "Forget what Desk remembers of …?": its exact counts, that its cost
 *  history stays, that it's never remembered again, and the restore window.
 *  What the hub says after (the sessions its work was handed on to may
 *  still hold what they read) is shown before the dialog closes. */
export function ForgetMemory({
  name,
  memory,
  engine,
  onForget,
  onClose,
}: {
  name: string;
  memory: SessionMemory;
  engine: Engine;
  /** Forgets it: what the person should know of it, if anything. */
  onForget: () => Promise<string | null | void>;
  onClose: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const told = useRef(false);
  // Every note it keeps goes, those replaced and dropped too.
  const notes = memory.notes.counts.kept ?? noteCount(memory.notes) + (memory.notes.replaced?.length ?? 0);
  const what = [count(memory.counts.exchanges, "exchange"), notes > 0 ? count(notes, "note") : null].filter(Boolean).join(" and ");
  if (notice)
    return (
      <Dialog
        onClose={onClose}
        title={(id) => (
          <header className="dialog-head">
            <span className="dialog-title">
              <h1 id={id} className="display-lg">
                Desk forgot “{name}”
              </h1>
            </span>
            <CloseButton onClose={onClose} />
          </header>
        )}
      >
        <div className="dialog-body confirm-body">
          <p role="status">{notice}</p>
        </div>
        <footer className="dialog-foot">
          <span className="dialog-foot-note" />
          <button type="button" className="btn btn-signal" data-autofocus onClick={onClose}>
            Close
          </button>
        </footer>
      </Dialog>
    );
  return (
    <Confirm
      title={`Forget what Desk remembers of “${name}”?`}
      action="Forget"
      onConfirm={async () => {
        const n = await onForget();
        if (n) {
          told.current = true;
          setNotice(n);
        }
      }}
      // Kept open once the hub said something of it, to be read.
      onClose={() => !told.current && onClose()}
    >
      <p>This removes its {what}, and its summary, from Desk.</p>
      <p className="muted">Its cost history stays (numbers only). Desk won't remember this conversation again, and {ENGINE_TITLE[engine]}'s own record of it isn't touched.</p>
      <p className="muted">{RESTORE_WINDOW}</p>
    </Confirm>
  );
}
