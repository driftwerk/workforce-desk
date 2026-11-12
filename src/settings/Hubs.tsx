import { useEffect, useState } from "react";
import { useChat } from "../chat/store";
import type { HubAccount } from "../chat/types";
import { PairHub } from "../hubs/PairHub";
import { capName, normaliseHubUrl, whoAmI, type Who } from "../hubs/pairing";
import { ProblemNote } from "../ui/ProblemNote";
import { explain } from "../ui/problem";
import { revokeSelf } from "../hubs/surface";
import { useDesk } from "../hub/store";
import { hubAccounts, removeHub, renameHub } from "../platform";

/** "Connected as Kings · kings@example.com", once the hub has said. */
export const connectedAs = (who: Who | undefined): string | null => {
  if (who?.state !== "person") return null;
  const name = [who.name, who.email].filter(Boolean).join(" · ");
  return name ? `Connected as ${name}` : null;
};

/** The name a workspace gives itself, to offer in place of the one Desk
 *  keeps when they differ: a name typed by hand when it was connected, or a
 *  typo ("Driftwork"). An older hub says none: nothing is offered. */
export const nameToOffer = (hub: Pick<HubAccount, "label">, who: Who | undefined): string | null => {
  const named = who?.state === "person" ? capName(who.workspace) : null;
  return named && named !== hub.label.trim() ? named : null;
};

const host = (url: string) => url.replace(/^https?:\/\//, "");

/** Other Workforce workspaces (Driftwerk, a client's) Desk is connected to. */
export function Hubs() {
  const { hubs, roster, rosterErrors, rosterTrouble, setHubs } = useChat();
  const fail = useDesk((s) => s.fail);
  const [connecting, setConnecting] = useState<{ again?: HubAccount } | null>(null);
  const [who, setWho] = useState<Record<string, Who>>({});
  // A machine's engine is the person's own, not a workspace (Settings →
  // Machines has it).
  const remote = hubs.filter((h) => !h.local && !h.machine);
  /** Read again whenever a workspace's token changes (paired again). */
  const revisions = remote.map((h) => `${h.id}:${h.revision}`).join("\n");

  useEffect(() => {
    let live = true;
    for (const h of useChat.getState().hubs.filter((x) => !x.local && !x.machine))
      void whoAmI(h).then((w) => live && setWho((all) => ({ ...all, [h.id]: w })));
    return () => {
      live = false;
    };
  }, [revisions]);

  const rename = async (hub: HubAccount, label: string) => {
    try {
      await renameHub(hub.id, label);
      setHubs(await hubAccounts());
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (hub: HubAccount) => {
    try {
      await revokeSelf(hub);
      await removeHub(hub.id);
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
            const trouble = rosterTrouble[h.id];
            // Nobody, on a token that otherwise works: not one that's gone.
            const anonymous = who[h.id]?.state === "nobody" && !rosterErrors[h.id];
            const signedOut = trouble === "signedOut";
            const offer = nameToOffer(h, who[h.id]);
            return (
              <div key={h.id} className="hub-row hub-row-who">
                <span className="hub-name">
                  <b className="display">{h.label}</b>
                  <span className="faint small mono">{host(h.url)}</span>
                  {as && <span className="small muted">{as}</span>}
                  {offer && (
                    <button type="button" className="link small hub-rename" onClick={() => void rename(h, offer)} title={`${host(h.url)} calls itself ${offer}`}>
                      Rename to {offer}
                    </button>
                  )}
                </span>
                <span className="small muted">
                  {trouble ? (trouble === "signedOut" ? "Signed out" : trouble === "unreachable" ? "Can’t reach it" : "Couldn’t read its agents") : `${roster.filter((a) => a.hubId === h.id).length} agents`}
                </span>
                {(anonymous || signedOut) && (
                  <button type="button" className="btn btn-signal" onClick={() => setConnecting({ again: h })}>
                    {signedOut ? "Sign in again" : "Sign in as you"}
                  </button>
                )}
                <button type="button" className="btn" onClick={() => void remove(h)}>
                  Disconnect
                </button>
                {anonymous && (
                  <p className="small state-blocked hub-row-warning" role="alert">
                    Connected without your account, so agents shared only with you are hidden.
                  </p>
                )}
                {trouble && trouble !== "signedOut" && (
                  <div className="hub-row-warning">
                    <ProblemNote
                      problem={
                        trouble === "unreachable"
                          ? {
                              plain: `Can’t reach ${host(h.url)}: check your internet or VPN.`,
                              fix: { label: "Try again", run: () => void useChat.getState().refreshRoster() },
                              details: rosterErrors[h.id],
                            }
                          : explain(new Error(rosterErrors[h.id] ?? ""), { what: `reading ${h.label}’s agents`, retry: () => void useChat.getState().refreshRoster() })
                      }
                    />
                  </div>
                )}
                {signedOut && (
                  <p className="small state-blocked hub-row-warning" role="alert">
                    Desk’s sign-in to {h.label} has expired or was revoked. Sign in again to see its agents.
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
          key={connecting.again?.id ?? "new"}
          again={connecting.again && { url: connecting.again.url, label: connecting.again.label }}
          onClose={() => setConnecting(null)}
          onAsYou={(paired) => {
            const same = (a: string) => {
              try {
                return normaliseHubUrl(a) === normaliseHubUrl(paired.url);
              } catch {
                return a === paired.url;
              }
            };
            const hub = useChat.getState().hubs.find((x) => same(x.url));
            setConnecting(hub ? { again: hub } : null);
          }}
        />
      )}
    </section>
  );
}
