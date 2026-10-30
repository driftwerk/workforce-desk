import { useEffect } from "react";
import { textOf } from "../chat/history";
import { useChat } from "../chat/store";
import { DESK_DM, type HubAccount } from "../chat/types";
import { floorHeard, floorUnheard, ask as readFloor } from "../floor/store";
import { deskState } from "../restore/boot";
import { drainer } from "../rooms/engine";
import { DELIVERY_LABEL, firstLine, notifyPlace, QUIET } from "../unread/notices";
import { cachedDms, dmsFrom, hubBack, refreshDms } from "../unread/summary";
import { readAloud } from "../voice/useVoice";
import { DRAIN_PREFIX } from "./drain";
import { HubLink, type Delivered } from "./link";
import { activeConversations } from "./surface";

// Desk's links to its hubs: one per paired hub, from the main window only.
// On every `hello` (a link opened, or opened again) each conversation that
// changed since Desk last looked is drained, and the floor read; on every
// delivery, its own conversation is, and you're told of it as its kind
// deserves; on every floor or usage signal, the hub's floor is read.

/** How far before Desk last looked it looks again: the hub's clock and
 *  this computer's need not agree. */
export const SINCE_MARGIN_MS = 5 * 60_000;

const seenKey = (hubId: string) => `${DRAIN_PREFIX}${hubId}.seen`;

/** The `since` to drain a hub from, as Desk last looked at it. */
export const sinceOf = (seen: unknown): string | null => {
  const at = typeof seen === "string" ? Date.parse(seen) : NaN;
  return Number.isNaN(at) ? null : new Date(at - SINCE_MARGIN_MS).toISOString();
};

/** How long a catch-up that left something undrained waits to try again,
 *  at first; each try after waits twice as long, up to `CATCH_UP_MAX_MS`. */
export const CATCH_UP_RETRY_MS = 30_000;
const CATCH_UP_MAX_MS = 10 * 60_000;

/** Catch-ups waiting to try again, by hub. */
const retries = new Map<string, ReturnType<typeof setTimeout>>();

const stopRetrying = (hubId: string) => {
  clearTimeout(retries.get(hubId));
  retries.delete(hubId);
};

/** Drains whatever changed on `hub` since Desk last looked; tried again
 *  later, for as long as its link stays, until all of it is placed. */
async function catchUp(hub: HubAccount, link: HubLink, wait = CATCH_UP_RETRY_MS) {
  stopRetrying(hub.id);
  const started = new Date().toISOString();
  let done = false;
  try {
    const active = await activeConversations(hub, sinceOf(deskState.get(seenKey(hub.id))));
    if (active) dmsFrom(hub, active);
    const drained = await Promise.allSettled((active ?? []).map((c) => drainer.drain(hub, c.agent_id, c.channel)));
    done = drained.every((d) => d.status === "fulfilled" && d.value);
  } catch (e) {
    console.warn(`couldn't catch up with ${hub.label}:`, e);
  }
  if (links.get(hub.id) !== link) return;
  if (done) deskState.set(seenKey(hub.id), started);
  else retries.set(hub.id, setTimeout(() => void catchUp(hub, link, Math.min(CATCH_UP_MAX_MS, wait * 2)), wait));
}

/** A message was delivered into one of your conversations on `hub`. */
async function arrived(hub: HubAccount, d: Delivered) {
  await drainer.drain(hub, d.agentId, d.channel).catch(() => false);
  const said = drainer.said(hub.id, d.agentId, d.messageId);
  const { roster } = useChat.getState();
  const agent = roster.find((a) => a.hubId === hub.id && a.id === d.agentId);
  const text = said ? textOf(said) : "";
  // A room's is told of once it's kept in the room.
  if (d.channel === DESK_DM) {
    void refreshDms(hub);
    notifyPlace({
      place: { kind: "dm", hub: hub.id, agent: d.agentId },
      urgency: d.kind === "notice" ? "new" : "forYou",
      quiet: QUIET.has(d.kind),
      id: `dm:${hub.id}/${d.agentId}/${d.messageId}`,
      title: `${agent?.name ?? d.agentId} · ${DELIVERY_LABEL[d.kind] ?? "Message"}`,
      body: firstLine(text),
    });
  }
  if (d.spoken && agent && text) readAloud(agent, text);
}

const links = new Map<string, HubLink>();
/** Hubs without a link for Desk, by the token they had, until they're
 *  paired again. */
const unlinked = new Map<string, string>();

const unfollow = (id: string) => {
  links.get(id)?.close();
  links.delete(id);
  stopRetrying(id);
};

/** Keeps a link open to each of `hubs`, and none to any other. */
export function followHubs(hubs: readonly HubAccount[]) {
  for (const [id, link] of links) {
    const now = hubs.find((h) => h.id === id);
    if (now && now.token === link.hub.token && now.url === link.hub.url) continue;
    unfollow(id);
    floorUnheard(id);
  }
  for (const hub of hubs) {
    if (links.has(hub.id) || unlinked.get(hub.id) === hub.token) continue;
    unlinked.delete(hub.id);
    cachedDms(hub);
    const link: HubLink = new HubLink(hub, {
      hello: (features) => {
        floorHeard(hub.id, features);
        useChat.getState().learnFeatures(hub.id, features);
        void hubBack(hub);
        void catchUp(hub, link);
      },
      delivered: (d) => void arrived(hub, d),
      changed: (what) => (what === "reads" ? void refreshDms(hub) : readFloor([hub.id])),
      closed: () => {
        stopRetrying(hub.id);
        floorUnheard(hub.id);
      },
      unavailable: () => {
        unfollow(hub.id);
        unlinked.set(hub.id, hub.token);
      },
    });
    links.set(hub.id, link);
  }
}

/** The main window's links to its hubs. */
export function useHubLinks() {
  const hubs = useChat((s) => s.hubs);
  useEffect(() => followHubs(hubs), [hubs]);
  useEffect(() => () => followHubs([]), []);
}
