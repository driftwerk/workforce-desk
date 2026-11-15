import { useEffect, useMemo, useRef, useState } from "react";
import { browserOf } from "../hub/browser";
import { HubError } from "../hub/client";
import { connectionsOf, type ConnectionsApi, type Setup } from "../hub/connections";
import { openLocalDm } from "../overview/people";
import { useLive } from "../ui/useLive";
import { claim, ownerOf, SetupCard, settled, useClaims } from "./SetupCard";
import { useChat } from "./store";
import "../styles/connections.css";

/** How often this computer's setups are asked about while one is under way. */
const BUSY_MS = 2000;
/** How often otherwise: a setup an agent starts shows within this. */
const IDLE_MS = 4000;
/** How long between asks at most, while the hub keeps failing. */
const MOST_MS = 60_000;

/** The setups of this computer's agents that no message on screen shows:
 *  each one's card, at the top of whatever the person is looking at (the
 *  Floor, a board, another agent's chat), so a setup waiting on them is never
 *  out of sight. A message that shows it takes it back. */
export function SetupDock() {
  const hub = useChat((s) => s.hubs.find((h) => h.local));
  const api = useMemo(() => (hub ? connectionsOf(hub) : null), [hub]);
  if (!hub || !api) return null;
  return <Dock key={hub.id} hub={hub.id} api={api} showPage={(agent) => browserOf(hub).show(agent)} />;
}

export function Dock({
  hub,
  api,
  showPage,
  every = { busy: BUSY_MS, idle: IDLE_MS },
}: {
  hub: string;
  api: ConnectionsApi;
  showPage: (agent: string) => Promise<boolean>;
  /** How often it asks (tests ask faster). */
  every?: { busy: number; idle: number };
}) {
  const [setups, setSetups] = useState<Setup[]>([]);
  /** The ones shown here once, kept until closed when they settle: the
   *  person sees what came of what they did. */
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const live = useLive();
  const anchor = useRef(Symbol("dock")).current;
  const roster = useChat((s) => s.roster);
  useClaims();

  useEffect(() => () => claim(anchor, 0, []), [anchor]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let before = new Set<string>();
    const tick = async () => {
      let wait = every.idle;
      try {
        const listed = (await api.setups()).filter((s) => s.ended == null);
        if (stop || !live.current) return;
        failures = 0;
        // Listed twice running: the message that started one has had its
        // own look first, so a card in the chat doesn't flash up here.
        const all = listed.filter((s) => before.has(s.id));
        before = new Set(listed.map((s) => s.id));
        setSetups(all);
        // Claimed last of all (from the start of time): any message that
        // shows one shows it instead.
        claim(
          anchor,
          0,
          all.map((s) => s.id),
        );
        if (listed.some((s) => !settled(s))) wait = every.busy;
      } catch (e) {
        if (stop) return;
        // A hub without setups has none to show.
        if (e instanceof HubError && e.status === 404) return;
        failures += 1;
        wait = Math.min(every.idle * 2 ** failures, MOST_MS);
      }
      timer = setTimeout(() => void tick(), wait);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, anchor, every.busy, every.idle]);

  const mine = setups.filter((s) => ownerOf(s.id) === anchor && !closed.has(s.id) && (!settled(s) || kept.has(s.id)));
  const fresh = mine.filter((s) => !settled(s) && !kept.has(s.id)).map((s) => s.id);
  // One a message shows now is the message's: once it settles there, it
  // doesn't come back here.
  const taken = [...kept].filter((id) => {
    const owner = ownerOf(id);
    return owner !== undefined && owner !== anchor;
  });
  useEffect(() => {
    if (fresh.length || taken.length) setKept((k) => new Set([...k, ...fresh].filter((id) => !taken.includes(id))));
  }, [fresh.join(" "), taken.join(" ")]);

  if (mine.length === 0) return null;
  return (
    <div className="setup-dock" role="region" aria-label="Setups waiting on you">
      {mine.map((s) => {
        const name = roster.find((a) => a.hubId === hub && a.id === s.agent)?.name ?? "An agent";
        return (
          <div key={s.id} className="setup-dock-item">
            <span className="setup-dock-head small muted">
              {name} is setting up {s.serviceName}
              {" · "}
              <button type="button" className="link small" onClick={() => openLocalDm(s.agent)}>
                Open the conversation
              </button>
              {settled(s) && (
                <>
                  {" · "}
                  <button type="button" className="link small" onClick={() => setClosed((c) => new Set([...c, s.id]))}>
                    Close
                  </button>
                </>
              )}
            </span>
            <SetupCard
              setup={s}
              api={api}
              origin={{ hub, agent: s.agent }}
              showPage={showPage}
              onChange={(n) => setSetups((list) => list.map((x) => (x.id === n.id ? n : x)))}
            />
          </div>
        );
      })}
    </div>
  );
}
