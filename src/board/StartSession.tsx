import { useEffect, useRef, useState } from "react";
import { ENGINE_TITLE, startable } from "../engines/engines";
import { sortedSessions, useDesk, localSessions } from "../hub/store";
import type { Engine, EngineInfo, Ticket } from "../hub/types";
import { pickFolder } from "../platform";
import { useModal } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { sessionsOf } from "./board";
import { useBoard } from "./store";

/** A new session for a ticket: its engine and folder; it starts with the
 *  ticket as its goal and first prompt, and the ticket moves to Doing. */
export function StartSession({ ticket: t, onClose }: { ticket: Ticket; onClose: () => void }) {
  const hub = useDesk((s) => s.hub);
  const sessions = useDesk((s) => localSessions(s.sessions));
  // The folder its sessions worked in, else the newest session's.
  const usual = sessionsOf(t)
    .map((id) => sessions[id]?.cwd)
    .find(Boolean) ?? sortedSessions(sessions)[0]?.cwd ?? "";
  const [engine, setEngine] = useState<Engine>("claude");
  const [cwd, setCwd] = useState(usual);
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sheet = useRef<HTMLFormElement>(null);
  const keys = useModal(sheet, onClose);
  useEffect(() => {
    let live = true;
    hub
      ?.engines()
      .then((e) => live && setEngines(e))
      .catch(() => live && setEngines(null));
    return () => {
      live = false;
    };
  }, [hub]);
  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cwd.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      await useBoard.getState().assign(t.id, { newSession: { path: cwd.trim(), engine } });
      onClose();
    } catch (err) {
      setProblem(plainError(err));
      setBusy(false);
    }
  };
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={keys}>
      <form ref={sheet} className="sheet" onSubmit={start} aria-label={`Start a session on ${t.key ?? "the ticket"}`} tabIndex={-1}>
        <h2 className="display-md">Start a session on {t.key ?? "it"}</h2>
        <p className="muted small">It starts with “{t.title}” as its goal and first prompt, and the ticket moves to Doing.</p>
        <div className="seg" role="radiogroup" aria-label="Engine">
          {startable(engines).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={engine === k} onClick={() => setEngine(k)}>
              {ENGINE_TITLE[k]}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Folder</span>
          <span className="field-row">
            <input data-autofocus value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/repo" required />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                const dir = await pickFolder();
                if (dir) setCwd(dir);
              }}
            >
              Choose…
            </button>
          </span>
        </label>
        {problem && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
        <footer className="sheet-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-signal" disabled={busy || !cwd.trim()}>
            Start session
          </button>
        </footer>
      </form>
    </div>
  );
}
