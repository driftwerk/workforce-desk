import { useState } from "react";
import { useDesk } from "../hub/store";

export function RestoreBanner() {
  const { restore, hub, fail } = useDesk();
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  if (!restore.length || !hub) return null;
  const run = (ids: string[]) => hub.restore(ids).catch(fail);
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <section className="restore" aria-label="Restore sessions">
      <div className="restore-head">
        <span className="restore-text">
          <b>
            {restore.length} session{restore.length === 1 ? " was" : "s were"} open when your Mac stopped
          </b>
          <span className="muted small">Each one resumes the same conversation in its own folder.</span>
        </span>
        <button type="button" className="btn btn-ghost" onClick={() => hub.dismissRestore().catch(fail)}>
          Not now
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setPicking((p) => !p)}>
          Choose…
        </button>
        <button type="button" className="btn btn-signal" onClick={() => run(restore.map((s) => s.id))}>
          Restore all
        </button>
      </div>
      {picking && (
        <div className="restore-pick">
          {restore.map((s) => (
            <label key={s.id} className="restore-row">
              <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
              <span className="mono">{s.name}</span>
              <span className="faint small">{s.goal || s.lastPrompt || s.cwd}</span>
            </label>
          ))}
          <button type="button" className="btn btn-signal" disabled={!picked.size} onClick={() => run([...picked])}>
            Restore {picked.size || ""}
          </button>
        </div>
      )}
    </section>
  );
}
