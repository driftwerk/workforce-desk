import { useEffect, useId, useState } from "react";
import { ENGINE_TITLE } from "../engines/engines";
import { useSessionName } from "../groups/names";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { Confirm } from "../ui/Confirm";
import { plainError } from "../ui/plainError";
import { runs } from "./actions";
import { clearFinished, closeLifecycle, endSessionNow, removeSession, useLifecycle } from "./lifecycle";

/** The confirms a session's life asks before it changes: ending one that
 *  works, removing one, clearing finished ones. Each opens with Cancel
 *  focused. One mounted per window. */
export function LifecycleDialogs() {
  const asking = useLifecycle((s) => s.asking);
  const session = useDesk((s) => (asking && asking.kind !== "clear" ? s.sessions[asking.sessionId] : undefined));
  if (!asking) return null;
  if (asking.kind === "clear") return <ClearFinished onClose={closeLifecycle} />;
  if (!session) return null;
  return asking.kind === "end" ? <EndSession session={session} onClose={closeLifecycle} /> : <RemoveSession session={session} onClose={closeLifecycle} />;
}

function EndSession({ session, onClose }: { session: Session; onClose: () => void }) {
  const name = useSessionName(session.id, session.name);
  return (
    <Confirm title={`End “${name}”?`} action="End session" onConfirm={() => endSessionNow(session.id)} onClose={onClose}>
      <p className="muted">It's working: ending it stops it now. It leaves the sidebar, and you can resume it later from Settings → Sessions.</p>
    </Confirm>
  );
}

/** Asks before removing `session` from Desk; deleting its engine's
 *  transcript too is the person's choice, unticked. */
export function RemoveSession({ session, onClose, onRemoved }: { session: Session; onClose: () => void; onRemoved?: () => void }) {
  const name = useSessionName(session.id, session.name);
  const [transcript, setTranscript] = useState(false);
  const engine = ENGINE_TITLE[session.engine];
  const running = runs(session);
  const elsewhere = running && !session.live;
  return (
    <Confirm
      title={elsewhere ? `Stop tracking “${name}”?` : `Remove “${name}”?`}
      action={elsewhere ? "Stop tracking" : "Remove"}
      onConfirm={async () => {
        await removeSession(session.id, transcript && !running);
        onRemoved?.();
      }}
      onClose={onClose}
    >
      <p className="muted">
        {elsewhere
          ? "It keeps running in its own terminal. Desk forgets it — its card, its Floor turns, its unread and its Activity — and won't pick it up again."
          : `Desk forgets it — its card, its Floor turns, its unread and its Activity — and won't pick it up again.${session.live ? " It's running, so it stops." : ""}`}{" "}
        You can track it again from Settings → Sessions.
      </p>
      <label className="confirm-check small">
        <input type="checkbox" checked={transcript && !running} disabled={running} onChange={(e) => setTranscript(e.target.checked)} />
        <span>
          Also delete its {engine} transcript
          {running ? " (not while it runs)" : transcript ? " — it can't be resumed after this" : ""}
        </span>
      </label>
    </Confirm>
  );
}

const DEFAULT_DAYS = 7;

/** Asks before removing every session that finished more than N days ago,
 *  saying how many that is. */
export function ClearFinished({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [count, setCount] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState(false);
  const daysId = useId();
  const valid = Number.isInteger(days) && days >= 0;
  useEffect(() => {
    if (!valid) return;
    let current = true;
    setCount(null);
    const t = setTimeout(() => {
      clearFinished(days, true)
        .then((n) => current && (setCount(n), setProblem(null)))
        .catch((e) => current && setProblem(plainError(e)));
    }, 200);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [days, valid]);
  const label = count === null ? "Clear" : `Clear ${count} session${count === 1 ? "" : "s"}`;
  return (
    <Confirm
      title="Clear finished sessions?"
      action={label}
      disabled={!valid || !count}
      onConfirm={async () => void (await clearFinished(days, false, transcripts))}
      onClose={onClose}
    >
      <p className="muted">Removes every session that stopped or was closed before then, as Remove does: Desk forgets them and won't pick them up again.</p>
      <label className="confirm-days small" htmlFor={daysId}>
        <span>Finished more than</span>
        <input id={daysId} type="number" min={0} step={1} value={Number.isNaN(days) ? "" : days} onChange={(e) => setDays(e.target.valueAsNumber)} />
        <span>days ago</span>
      </label>
      <label className="confirm-check small">
        <input type="checkbox" checked={transcripts} onChange={(e) => setTranscripts(e.target.checked)} />
        <span>Also delete their transcripts{transcripts ? " — they can't be resumed after this" : ""}</span>
      </label>
      <p className="faint small" aria-live="polite">
        {problem ?? (!valid ? "Say how many days." : count === null ? "Counting…" : count === 0 ? "None finished that long ago." : `${count} to clear.`)}
      </p>
    </Confirm>
  );
}
