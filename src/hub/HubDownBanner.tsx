import { useEffect, useRef, useState } from "react";
import { helperLastReason, openLoginItems, startHelper } from "../platform";
import { refusal } from "./helperNote";
import { useHost } from "../shell/host";
import { useDesk } from "./store";

/** How long this computer's hub may be out of reach before Desk says so. */
export const GRACE_MS = 4_000;
/** How long after "Start it" Desk waits for the hub before saying it still
 *  isn't answering. */
export const START_WAIT_MS = 45_000;

/** True once the local hub has been unreachable for `grace`; false again the
 *  moment it answers. */
export function useHubDown(grace = GRACE_MS): boolean {
  const connected = useDesk((s) => s.connected);
  const [down, setDown] = useState(false);
  useEffect(() => {
    if (connected) {
      setDown(false);
      return;
    }
    const t = setTimeout(() => setDown(true), grace);
    return () => clearTimeout(t);
  }, [connected, grace]);
  return down;
}

/** A quiet notice that this computer's hub isn't answering, with the last
 *  reason desk-hubd logged and a way to start it. The sidebar and Floor stay
 *  as they were (see `hubDown` on `.app`), marked stale. */
export function HubDownBanner({ down }: { down: boolean }) {
  const noLocalHub = useHost((h) => h.platform === "windows" && h.host === null);
  const [reason, setReason] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState<{ text: string; login?: true } | null>(null);
  const [slow, setSlow] = useState(false);
  const wait = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!down) {
      setStarting(false);
      setNote(null);
      setSlow(false);
      clearTimeout(wait.current);
      return;
    }
    let live = true;
    helperLastReason()
      .then((r) => live && setReason(r))
      .catch(() => live && setReason(null));
    return () => {
      live = false;
    };
  }, [down]);
  useEffect(() => () => clearTimeout(wait.current), []);

  if (!down || noLocalHub) return null;

  const start = () => {
    setStarting(true);
    setSlow(false);
    setNote(null);
    startHelper()
      .then((status) => {
        const no = refusal(status);
        if (no) {
          setStarting(false);
          setNote(no);
          return;
        }
        clearTimeout(wait.current);
        wait.current = setTimeout(() => {
          setStarting(false);
          setSlow(true);
          helperLastReason()
            .then(setReason)
            .catch(() => {});
        }, START_WAIT_MS);
      })
      .catch((e: unknown) => {
        setStarting(false);
        setNote({ text: e instanceof Error ? e.message : String(e) });
      });
  };

  return (
    <section className="hub-down" role="status" aria-label="Desk’s helper on this computer">
      <span className="hub-down-text">
        <b>{starting ? "Starting Desk’s helper…" : "Desk’s helper isn’t running"}</b>
        <span className="muted small">
          {starting
            ? "Reconnecting as soon as it answers."
            : "What you see is from before it stopped, and it won’t change until the helper is back."}
        </span>
        {!starting && (note || slow) && (
          <span className="small hub-down-note">{note ? note.text : "It was started but isn’t answering yet."}</span>
        )}
        {!starting && reason && <span className="faint small hub-down-reason">Last logged: {reason}</span>}
      </span>
      {note?.login ? (
        <button type="button" className="btn btn-signal" onClick={() => void openLoginItems()}>
          Open login items
        </button>
      ) : (
        <button type="button" className="btn btn-signal" disabled={starting} onClick={start}>
          {starting ? "Starting…" : "Start it"}
        </button>
      )}
    </section>
  );
}
