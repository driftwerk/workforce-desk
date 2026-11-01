import { useCallback, useEffect, useState } from "react";
import { ENGINE_SHORT } from "../engines/engines";
import { useDesk } from "../hub/store";
import type { HiddenSession, Session } from "../hub/types";
import { resumable } from "../session/actions";
import { RemoveSession } from "../session/LifecycleDialogs";
import { askLifecycle, useLifecycle } from "../session/lifecycle";
import { homeShort } from "../ui/paths";
import { plainError } from "../ui/plainError";

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/** Sessions Desk no longer shows: closed ones, to resume or remove, and
 *  removed ones, to track again; and clearing finished ones in bulk. */
export function Sessions() {
  const hub = useDesk((s) => s.hub);
  const fail = useDesk((s) => s.fail);
  // Read again once a confirm here (clear, remove) has closed.
  const asking = useLifecycle((s) => s.asking);
  const [closed, setClosed] = useState<Session[] | null>(null);
  const [hidden, setHidden] = useState<HiddenSession[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Session | null>(null);
  const load = useCallback(async () => {
    if (!hub) return;
    try {
      const [c, h] = await Promise.all([hub.closedSessions(), hub.hiddenSessions()]);
      setClosed(c);
      setHidden(h);
      setProblem(null);
    } catch (e) {
      setProblem(plainError(e));
    }
  }, [hub]);
  useEffect(() => {
    if (!asking && !removing) void load();
  }, [load, asking, removing]);

  const resume = async (s: Session) => {
    try {
      await hub?.resume(s.id);
      useDesk.getState().open(s.id);
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const trackAgain = async (h: HiddenSession) => {
    try {
      await hub?.trackAgain(h);
      await load();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <section className="settings-pane" aria-label="Sessions">
      <h1 className="display-lg">Sessions</h1>
      <p className="muted">Sessions you've ended, or that closed in their own terminals, and the ones you removed from Desk.</p>
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      <div>
        <button type="button" className="btn" onClick={() => askLifecycle({ kind: "clear" })}>
          Clear finished sessions…
        </button>
      </div>

      <section className="prov-section" aria-label="Closed">
        <h2 className="field-label">Closed</h2>
        {closed === null ? (
          <p className="faint small">Loading…</p>
        ) : closed.length === 0 ? (
          <p className="faint small">None.</p>
        ) : (
          <div className="hub-list">
            {closed.map((s) => (
              <div key={s.id} className="hub-row">
                <span className="hub-name">
                  <b className="mono">{s.displayName ?? s.name}</b>
                  <span className="faint small">
                    {[ENGINE_SHORT[s.engine], homeShort(s.cwd), s.origin === "external" ? "from another terminal" : null, when(s.updatedAt)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {resumable(s) && (
                  <button type="button" className="btn btn-signal" onClick={() => void resume(s)}>
                    {s.origin === "external" ? "Resume in Desk" : "Resume"}
                  </button>
                )}
                <button type="button" className="btn" onClick={() => setRemoving(s)}>
                  Remove…
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="prov-section" aria-label="Removed from Desk">
        <h2 className="field-label">Removed from Desk</h2>
        <p className="faint small">Desk doesn't pick these up from other terminals. Tracked again, one shows the next time it runs.</p>
        {hidden === null ? (
          <p className="faint small">Loading…</p>
        ) : hidden.length === 0 ? (
          <p className="faint small">None.</p>
        ) : (
          <div className="hub-list">
            {hidden.map((h) => (
              <div key={`${h.engine}:${h.cliSessionId}`} className="hub-row">
                <span className="hub-name">
                  <b className="mono">{h.name}</b>
                  <span className="faint small">{[ENGINE_SHORT[h.engine], homeShort(h.cwd), `removed ${when(h.hiddenAt)}`].join(" · ")}</span>
                </span>
                <button type="button" className="btn" onClick={() => void trackAgain(h)}>
                  Start tracking again
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      {removing && <RemoveSession session={removing} onClose={() => setRemoving(null)} />}
    </section>
  );
}
