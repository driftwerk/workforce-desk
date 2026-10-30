import { useEffect } from "react";
import { textOf, type HubMessage } from "../chat/history";
import { useChat } from "../chat/store";
import { DESK_DM, type DeliveryKind, type HubAccount } from "../chat/types";
import { deskState } from "../restore/boot";
import { drainer } from "../rooms/engine";
import { notify } from "../shell/notify";
import { readAloud } from "../voice/useVoice";
import { DRAIN_PREFIX } from "./drain";
import { HubLink, type Delivered, type Unlinked } from "./link";
import { activeConversations } from "./surface";

// Desk's links to its hubs: one per paired hub, from the main window only.
// On every `hello` (a link opened, or opened again) each conversation that
// changed since Desk last looked is drained; on every delivery, its own
// conversation is, and you're told of it as its kind deserves.

/** How far before Desk last looked it looks again: the hub's clock and
 *  this Mac's need not agree. */
export const SINCE_MARGIN_MS = 5 * 60_000;

const seenKey = (hubId: string) => `${DRAIN_PREFIX}${hubId}.seen`;

/** What a delivery is called when you're told of it; kinds not here aren't
 *  worth a notification. */
const NOTIFIED: Partial<Record<DeliveryKind, string>> = {
  reminder: "Reminder",
  job: "Scheduled job",
  approval: "Needs your approval",
  check_in: "Check-in",
};

/** The `since` to drain a hub from, as Desk last looked at it. */
export const sinceOf = (seen: unknown): string | null => {
  const at = typeof seen === "string" ? Date.parse(seen) : NaN;
  return Number.isNaN(at) ? null : new Date(at - SINCE_MARGIN_MS).toISOString();
};

/** A hub's link opened: whatever changed while it was down is drained. */
async function caughtUp(hub: HubAccount, features: ReadonlySet<string>) {
  useChat.getState().learnFeatures(hub.id, features);
  const started = new Date().toISOString();
  try {
    const active = await activeConversations(hub, sinceOf(deskState.get(seenKey(hub.id))));
    if (!active) return;
    const drained = await Promise.allSettled(active.map((c) => drainer.drain(hub, c.agent_id, c.channel)));
    if (drained.every((d) => d.status === "fulfilled")) deskState.set(seenKey(hub.id), started);
  } catch (e) {
    console.warn(`couldn't catch up with ${hub.label}:`, e);
  }
}

/** A message was delivered into one of your conversations on `hub`. */
async function arrived(hub: HubAccount, d: Delivered) {
  const read: HubMessage[] = await drainer.drain(hub, d.agentId, d.channel).catch(() => []);
  const said = read.find((m) => m.id === d.messageId);
  const key = `${hub.id}/${d.agentId}`;
  const { roster, bumpDm } = useChat.getState();
  const agent = roster.find((a) => a.hubId === hub.id && a.id === d.agentId);
  if (d.channel === DESK_DM) bumpDm(key);
  const label = NOTIFIED[d.kind];
  const text = said ? textOf(said) : "";
  if (label) void notify({ title: `${agent?.name ?? d.agentId} · ${label}`, body: text.split("\n")[0]?.slice(0, 200) ?? "" });
  if (d.spoken && agent && text) readAloud(agent, text);
}

const links = new Map<string, HubLink>();
/** Hubs without a link for Desk, until they're paired again. */
const unlinked = new Map<string, { why: Unlinked; token: string }>();

/** Keeps a link open to each of `hubs`, and none to any other. */
export function followHubs(hubs: readonly HubAccount[]) {
  for (const [id, link] of links) {
    const now = hubs.find((h) => h.id === id);
    if (now && now.token === link.hub.token && now.url === link.hub.url) continue;
    link.close();
    links.delete(id);
  }
  for (const hub of hubs) {
    if (links.has(hub.id) || unlinked.get(hub.id)?.token === hub.token) continue;
    unlinked.delete(hub.id);
    links.set(
      hub.id,
      new HubLink(hub, {
        hello: (features) => void caughtUp(hub, features),
        delivered: (d) => void arrived(hub, d),
        unavailable: (why) => {
          links.get(hub.id)?.close();
          links.delete(hub.id);
          unlinked.set(hub.id, { why, token: hub.token });
        },
      }),
    );
  }
}

/** The main window's links to its hubs. */
export function useHubLinks() {
  const hubs = useChat((s) => s.hubs);
  useEffect(() => followHubs(hubs), [hubs]);
  useEffect(() => () => followHubs([]), []);
}
