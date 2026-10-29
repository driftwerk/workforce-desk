import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import type { HubAccount } from "../chat/types";
import { PairHub } from "../hubs/PairHub";
import { whoAmI, type Who } from "../hubs/pairing";
import { useDesk } from "../hub/store";
import { hubAccounts, removeHub } from "../platform";

/** "Connected as Kings · kings@example.com", once the hub has said. */
export const connectedAs = (who: Who | undefined): string | null => {
  if (who?.state !== "person") return null;
  const name = [who.name, who.email].filter(Boolean).join(" · ");
  return name ? `Connected as ${name}` : null;
};

/** Other Workforce workspaces (Driftwerk, a client's) Desk is connected to. */
export function Hubs() {
  const { hubs, roster, rosterErrors, setHubs } = useChat();
  const fail = useDesk((s) => s.fail);
  const [connecting, setConnecting] = useState<{ again?: HubAccount } | null>(null);
  const [who, setWho] = useState<Record<string, Who>>({});
  const remote = hubs.filter((h) => !h.local);
  /** Read again whenever a workspace's token changes (paired again). */
  const tokens = remote.map((h) => `${h.id}:${h.token}`).join("\n");

  useEffect(() => {
    let live = true;
    for (const h of useChat.getState().hubs.filter((x) => !x.local))
      void whoAmI(h.url, h.token).then((w) => live && setWho((all) => ({ ...all, [h.id]: w })));
    return () => {
      live = false;
    };
  }, [tokens]);

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
          {remote.map((h) => {
            const as = connectedAs(who[h.id]);
            // Nobody, on a token that otherwise works: not one that's gone.
            const anonymous = who[h.id]?.state === "nobody" && !rosterErrors[h.id];
            return (
              <div key={h.id} className="hub-row hub-row-who">
                <span className="hub-name">
                  <b className="display">{h.label}</b>
                  <span className="faint small mono">{h.url.replace(/^https?:\/\//, "")}</span>
                  {as && <span className="small muted">{as}</span>}
                </span>
                <span className="small muted">
                  {rosterErrors[h.id] ?? `${roster.filter((a) => a.hubId === h.id).length} agents`}
                </span>
                {anonymous && (
                  <button type="button" className="btn btn-signal" onClick={() => setConnecting({ again: h })}>
                    Connect as you
                  </button>
                )}
                <button type="button" className="btn" onClick={() => void remove(h.id)}>
                  Disconnect
                </button>
                {anonymous && (
                  <p className="small state-blocked hub-row-warning" role="alert">
                    Connected without your account, so agents shared only with you are hidden.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      <button type="button" className="btn btn-signal" onClick={() => setConnecting({})}>
        Connect a workspace
      </button>
      {connecting && (
        <PairHub
          again={connecting.again && { url: connecting.again.url, label: connecting.again.label }}
          onClose={() => setConnecting(null)}
        />
      )}
    </section>
  );
}
