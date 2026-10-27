import { useState } from "react";
import { useChat } from "../chat/store";
import { PairHub } from "../hubs/PairHub";
import { useDesk } from "../hub/store";
import { hubAccounts, removeHub } from "../platform";

export function Hubs() {
  const { hubs, roster, rosterErrors, setHubs } = useChat();
  const fail = useDesk((s) => s.fail);
  const [pairing, setPairing] = useState(false);
  const remove = async (id: string) => {
    try {
      await removeHub(id);
      setHubs(await hubAccounts());
    } catch (e) {
      fail(e);
    }
  };
  return (
    <section className="settings-pane" aria-label="Hubs">
      <h1 className="display-lg">Hubs</h1>
      <p className="muted">
        Desk talks to your local hub and to any hub it is paired with, the way your phone is. Each hub keeps its own agents,
        memory and history.
      </p>
      <div className="hub-list">
        {hubs.map((h) => (
          <div key={h.id} className="hub-row">
            <span className="hub-name">
              <b className="display">{h.label}</b>
              <span className="faint small mono">{h.url}</span>
            </span>
            <span className="small muted">
              {rosterErrors[h.id] ?? `${roster.filter((a) => a.hubId === h.id).length} agents`}
            </span>
            {!h.local && (
              <button type="button" className="btn" onClick={() => void remove(h.id)}>
                Unpair
              </button>
            )}
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-signal" onClick={() => setPairing(true)}>
        Pair a hub
      </button>
      {pairing && <PairHub onClose={() => setPairing(false)} />}
    </section>
  );
}
