import { useState } from "react";
import { useChat } from "../chat/store";
import { PairHub } from "../hubs/PairHub";
import { useDesk } from "../hub/store";
import { hubAccounts, removeHub } from "../platform";

/** Other Workforce workspaces (Driftwerk, a client's) Desk is connected to. */
export function Hubs() {
  const { hubs, roster, rosterErrors, setHubs } = useChat();
  const fail = useDesk((s) => s.fail);
  const [connecting, setConnecting] = useState(false);
  const remote = hubs.filter((h) => !h.local);
  const remove = async (id: string) => {
    try {
      await removeHub(id);
      setHubs(await hubAccounts());
    } catch (e) {
      fail(e);
    }
  };
  return (
    <section className="settings-pane" aria-label="Workspaces">
      <h1 className="display-lg">Workspaces</h1>
      <p className="muted">
        Connect a Workforce workspace you belong to — your company’s or a client’s — and its agents join your Crew, the way they
        are on your phone.
      </p>
      {remote.length > 0 && (
        <div className="hub-list">
          {remote.map((h) => (
            <div key={h.id} className="hub-row">
              <span className="hub-name">
                <b className="display">{h.label}</b>
                <span className="faint small mono">{h.url.replace(/^https?:\/\//, "")}</span>
              </span>
              <span className="small muted">
                {rosterErrors[h.id] ?? `${roster.filter((a) => a.hubId === h.id).length} agents`}
              </span>
              <button type="button" className="btn" onClick={() => void remove(h.id)}>
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="btn btn-signal" onClick={() => setConnecting(true)}>
        Connect a workspace
      </button>
      {connecting && <PairHub onClose={() => setConnecting(false)} />}
    </section>
  );
}
