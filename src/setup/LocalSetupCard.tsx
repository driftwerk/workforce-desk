import { useHost } from "../shell/host";
import { useSetup } from "./store";

/** On Windows before Desk is set up in WSL, once the person chose "Not
 *  now": local agents and sessions can't run yet, and the Floor says so
 *  with the way back, rather than leaving them quietly dead. */
export function LocalSetupCard() {
  const needed = useHost((h) => h.platform === "windows" && h.host === null);
  const skipped = useSetup((s) => s.skipped);
  const show = useSetup((s) => s.show);
  if (!needed || !skipped) return null;
  return (
    <section className="floor-card" aria-label="Set up local agents">
      <div className="floor-card-head">
        <h2 className="display floor-card-title">Set up local agents</h2>
      </div>
      <p className="small muted">
        Agents, terminals and sessions on this computer run in Linux, inside WSL, and Desk isn’t set up there yet. Workspaces you
        connect work meanwhile.
      </p>
      <div>
        <button type="button" className="btn btn-sm btn-signal" onClick={show}>
          Set it up
        </button>
      </div>
    </section>
  );
}
