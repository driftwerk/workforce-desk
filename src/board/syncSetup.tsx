// What a board's sync needs switched on, and Desk switching it on: asking
// a hub's agent, or turning it on for this computer's own agent. Shared by
// the link dialog and the sync bar; kept apart from the link dialog so a
// grid's window (whose board panes have the bar) never reaches minting a
// sync token (see board/chrome.tsx).

import { type ReactNode, useEffect, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { openTarget } from "../shell/navigate";
import { ProblemNote } from "../ui/ProblemNote";
import type { Problem } from "../ui/problem";
import { HubError } from "../hub/client";
import { useDesk } from "../hub/store";
import { SYSTEM_TITLE } from "../hub/boardSync";
import type { SyncSystem } from "../hub/types";
import { localHubRef, type SyncChoice } from "./syncStore";
import { connectionsOf, type Listing } from "../hub/connections";
import { Connect } from "../settings/Connections";
import { useAgentConfigs } from "../crew/agentBrain";
import { bindingOf, choose, setAgentConnectors, throughOf, todayOf } from "../crew/connectors";

/** A refusal in the hub's words, or why it couldn't be asked. */
const saidOf = (e: unknown): string =>
  e instanceof HubError ? e.message : e instanceof TypeError ? "Desk isn't ready right now. Try again in a moment." : e instanceof Error ? e.message : String(e);

/** What to say to an agent there so someone switches the system on. */
export const switchOnText = (system: SyncSystem, hub: string): string =>
  `Could you switch ${SYSTEM_TITLE[system]} on for an agent I can use on ${hub}? Desk needs it to sync one of my boards with ${SYSTEM_TITLE[system]}. If you can't, please tell me who can.`;

/** No agent on a hub has the system switched on: said in the one shape
 *  errors take, with asking an agent there to switch it on (in a DM, as the
 *  person), or whom to ask when there's no agent there to ask. */
export function NoAgent({ choice, system, words }: { choice: SyncChoice; system: SyncSystem; words: string }) {
  const title = SYSTEM_TITLE[system];
  const roster = useChat((s) => s.roster);
  const there = roster.filter((a) => a.hubId === choice.paired).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const agent = there[0];
  const [asked, setAsked] = useState(false);
  const problem: Problem = {
    plain: words,
    ...(agent
      ? {
          fix: {
            label: `Ask ${agent.name} to switch ${title} on`,
            run: () => {
              const key = agentKey(agent);
              openTarget({ kind: "agent", key }, { beside: true });
              void useChat
                .getState()
                .sendTo(key, switchOnText(system, choice.name))
                .then((sent) => setAsked(sent));
            },
          },
        }
      : {}),
  };
  if (asked)
    return (
      <p className="move-callout" role="status">
        Asked {agent?.name} on {choice.name} to switch {title} on. Link again once it’s on.
      </p>
    );
  return (
    <div className="move-callout sync-no-agent">
      <ProblemNote problem={problem} />
      {!agent && <p className="move-opt-sub">Ask whoever runs {choice.name} to switch {title} on for an agent you can use.</p>}
    </div>
  );
}

/** This computer hasn't the system's tools for the person, and no hub
 *  offers them: Desk turns them on itself. A board here syncs through this
 *  computer's default agent's tools with the person's own connection, so
 *  Desk turns the connector on for that agent; the one thing it can't make
 *  up is the person's key, so with no connection yet it asks for one in
 *  place first. Then the dialog asks this computer again. */
export function ThisComputerSetup({ system, disabled, onReady, fallback = null }: { system: SyncSystem; disabled: boolean; onReady: () => void; fallback?: ReactNode }) {
  const title = SYSTEM_TITLE[system];
  const desk = useDesk((s) => s.hub);
  const local = localHubRef();
  const agent = useChat((s) => (local ? s.roster.find((a) => a.hubId === local.id && a.isDefault) : undefined));
  const key = agent ? agentKey(agent) : "";
  const config = useAgentConfigs((s) => s.configs[key]);
  const [api] = useState(() => (local ? connectionsOf(local) : null));
  const [listing, setListing] = useState<Listing | null>(null);
  const [unlisted, setUnlisted] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    api.list().then(setListing, () => setUnlisted(true));
  }, [api]);
  // Read fresh each time: it may have changed since it was last read.
  useEffect(() => {
    if (desk && agent) void useAgentConfigs.getState().load(desk, agent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk, agent?.id]);

  const connector = listing?.connectors.find((c) => c.id === system);
  // Where Desk can't help, what the caller offers instead; nothing while
  // the connections and the agent's config are still being read.
  // (Connections that couldn't be read, or have no such connector, too.)
  if (!api || !desk || !agent || unlisted || (listing && !connector)) return <>{fallback}</>;
  if (!connector || config === undefined) return null;
  // The person's own connection, for all their agents: a board here syncs
  // with their keys, never one kept just for an agent.
  const connected = connector.connections.some((x) => x.status === "connected" && x.level === "all");
  const on = throughOf(bindingOf(config), system) !== "off";
  // Connected and on, yet not offered: nothing here Desk can change; the
  // row says why.
  if (connected && on) return <>{fallback}</>;

  const turnOn = async () => {
    setWorking(true);
    setProblem(null);
    try {
      if (!on) {
        const fresh = await api.list();
        const toml = await setAgentConnectors(desk, agent.id, (b) =>
          throughOf(b, system) === "off" ? choose(b, system, "mine", todayOf(fresh, agent.id)) : b,
        );
        useAgentConfigs.getState().put(key, toml);
      }
      // A connection just made shows as made, should this computer still
      // not offer it.
      api.list().then(setListing, () => {});
      onReady();
    } catch (e) {
      setProblem(saidOf(e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="move-callout sync-this-computer">
      {connected ? (
        <ProblemNote
          problem={{
            plain: `${title} is connected on this computer, but it’s off for ${agent.name}, whose tools a board here syncs through.`,
            ...(working || disabled ? {} : { fix: { label: `Turn ${title} on for ${agent.name}`, run: () => void turnOn() } }),
          }}
        />
      ) : (
        <>
          <p className="move-opt-sub">
            Connect {title} to sync through this computer{on ? "" : `; Desk turns it on for ${agent.name}`}.
          </p>
          <Connect api={api} connector={connector} at={{ level: "all" }} label={`Connect ${title}`} onDone={turnOn} />
        </>
      )}
      {working && (
        <p className="move-opt-sub" role="status">
          Turning {title} on…
        </p>
      )}
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
