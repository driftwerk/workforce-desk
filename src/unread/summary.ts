import { create } from "zustand";
import { useChat } from "../chat/store";
import { DESK_DM, type HubAccount } from "../chat/types";
import { deskListeners, useDesk } from "../hub/store";
import type { DeskEvent, UnreadSummary } from "../hub/types";
import { activeConversations, type Active, type ConversationUnread } from "../hubs/surface";
import { deskState } from "../restore/boot";
import { flushPending, heard, loadLocal, onDmWritten, useReads } from "./reads";

// What's unread, as the hubs that own it count it: this computer's hub's
// summary of its places, and each agent hub's count of your DMs. Read on
// every snapshot and hello, and again (debounced) after anything that can
// change it; nothing polls and nothing is counted here. A hub that's away
// shows its last counts, kept under `unread.cache.<hub>`.

interface UnreadState {
  local: UnreadSummary | null;
  /** When `local` was read (ms), for "as of" while the hub is away. */
  localAt: number | null;
  /** What's unread in each DM, by agent key (`hub/agent`). */
  dms: Record<string, ConversationUnread>;
  /** When each hub's DM counts were read (ms), by hub id. */
  dmsAt: Record<string, number>;
}

export const useUnread = create<UnreadState>(() => ({ local: null, localAt: null, dms: {}, dmsAt: {} }));

/** What a hub that keeps DM read points says it does. */
export const FEATURE_READS = "desk.reads";

/** After an event that can change the summary, it's read once things settle. */
export const SUMMARY_DEBOUNCE_MS = 300;

const cacheKey = (hubId: string) => `unread.cache.${hubId}`;
const localHubId = (): string | undefined => useChat.getState().hubs.find((h) => h.local)?.id;

interface Cached {
  at: number;
  local?: UnreadSummary;
  dms?: Record<string, ConversationUnread>;
}

const cached = (hubId: string): Cached | null => {
  const v = deskState.get(cacheKey(hubId));
  return v && typeof v === "object" && typeof (v as Cached).at === "number" ? (v as Cached) : null;
};

/** Reads this computer's summary now. */
export async function refreshLocal(): Promise<void> {
  const hub = useDesk.getState().hub;
  if (!hub) return;
  try {
    const local = await hub.unread();
    const at = Date.now();
    useUnread.setState({ local, localAt: at });
    // The main window keeps what was counted, for while the hub is away.
    const id = localHubId();
    if (id && !useDesk.getState().detached) deskState.set(cacheKey(id), { ...cached(id), at, local } satisfies Cached);
  } catch {
    /* Its last counts stand until the hub answers. */
  }
}

let soon: ReturnType<typeof setTimeout> | undefined;
/** Reads this computer's summary once events stop for a moment. */
export const refreshLocalSoon = (): void => {
  clearTimeout(soon);
  soon = setTimeout(() => void refreshLocal(), SUMMARY_DEBOUNCE_MS);
};

/** A listing of `hub`'s conversations says which DMs have something unread
 *  (one with nothing unread isn't listed, or says zero) and how far each
 *  was read. A hub that keeps no read points (it doesn't say `desk.reads`)
 *  says nothing. */
export function dmsFrom(hub: HubAccount, rows: readonly Active[]): void {
  const dmRows = rows.filter((r) => r.channel === DESK_DM);
  const keeps = useChat.getState().hubFeatures[hub.id]?.has(FEATURE_READS) || dmRows.some((r) => r.unread !== undefined || r.read !== undefined);
  if (!keeps) return;
  const at = Date.now();
  const prefix = `${hub.id}/`;
  useUnread.setState((s) => {
    const dms = Object.fromEntries(Object.entries(s.dms).filter(([key]) => !key.startsWith(prefix)));
    for (const r of dmRows) if (r.unread && r.unread.count > 0) dms[`${hub.id}/${r.agent_id}`] = r.unread;
    const mine = Object.fromEntries(Object.entries(dms).filter(([key]) => key.startsWith(prefix)));
    deskState.set(cacheKey(hub.id), { ...cached(hub.id), at, dms: mine } satisfies Cached);
    return { dms, dmsAt: { ...s.dmsAt, [hub.id]: at } };
  });
  useReads.setState((s) => ({
    dms: {
      ...s.dms,
      ...Object.fromEntries(dmRows.flatMap((r) => (r.read ? [[`${hub.id}/${r.agent_id}`, { at: r.read.at, message: r.read.message_id }]] : []))),
    },
  }));
}

/** Reads `hub`'s DM counts again: rows with something unread are listed
 *  whatever `since` says. */
export async function refreshDms(hub: HubAccount): Promise<void> {
  try {
    const rows = await activeConversations(hub, new Date().toISOString());
    if (rows) dmsFrom(hub, rows);
  } catch {
    /* Its last counts stand until it answers. */
  }
}

onDmWritten((hub) => void refreshDms(hub));

const counting = new Map<string, ReturnType<typeof setTimeout>>();
/** Reads `hub`'s DM counts again once things settle. */
const refreshDmsSoon = (hub: HubAccount): void => {
  clearTimeout(counting.get(hub.id));
  counting.set(
    hub.id,
    setTimeout(() => {
      counting.delete(hub.id);
      void refreshDms(hub);
    }, SUMMARY_DEBOUNCE_MS),
  );
};

/** A DM's turn that ended left an answer its hub now counts, wherever you
 *  are: the main window asks it (a detached grid's has no links). */
const watchDmTurns = (): (() => void) =>
  useChat.subscribe((s, was) => {
    if (s.conversations === was.conversations || useDesk.getState().detached) return;
    for (const [key, c] of Object.entries(s.conversations)) {
      if (!was.conversations[key]?.working || c.working) continue;
      const hub = s.hubs.find((h) => key.startsWith(`${h.id}/`));
      if (hub) refreshDmsSoon(hub);
    }
  });

/** A hub is linked again: what waited for it is sent. */
export const hubBack = (hub: HubAccount): Promise<void> => flushPending(hub.id);

/** Unpaired hubs' counts go; their cache and waiting writes are left for
 *  a hub paired again under the same id. */
export function forgetHubs(hubs: readonly HubAccount[]): void {
  const ids = new Set(hubs.map((h) => h.id));
  useUnread.setState((s) => ({
    dms: Object.fromEntries(Object.entries(s.dms).filter(([key]) => ids.has(key.split("/")[0]!))),
    dmsAt: Object.fromEntries(Object.entries(s.dmsAt).filter(([id]) => ids.has(id))),
  }));
}

/** Events after which the summary may say something else. */
const CHANGES: ReadonlySet<DeskEvent["type"]> = new Set(["roomMessage", "read", "session", "removed", "activity", "room", "roomRemoved"]);

const onEvent = (e: DeskEvent) => {
  if (e.type === "read") heard([{ place: e.place, ...e.point }]);
  if (e.type === "snapshot") {
    void refreshLocal();
    const hub = useDesk.getState().hub;
    void hub
      ?.reads()
      .then(loadLocal)
      .catch(() => undefined);
    const id = localHubId();
    if (id) void flushPending(id);
  } else if (CHANGES.has(e.type)) refreshLocalSoon();
};

/** Each window keeps the counts: from the events socket, and in the main
 *  window from what was last counted while the hubs are away. A detached
 *  grid's tells nobody (`notifyPlace` sends from the main window only). */
export function startUnread(): () => void {
  const id = localHubId();
  const kept = id ? cached(id) : null;
  if (kept?.local && !useUnread.getState().local) useUnread.setState({ local: kept.local, localAt: kept.at });
  deskListeners.add(onEvent);
  const unwatch = watchDmTurns();
  return () => {
    deskListeners.delete(onEvent);
    unwatch();
    clearTimeout(soon);
    for (const t of counting.values()) clearTimeout(t);
    counting.clear();
  };
}

/** DM counts kept from before, for a hub not heard from yet. */
export function cachedDms(hub: HubAccount): void {
  const kept = cached(hub.id);
  if (!kept?.dms || hub.id in useUnread.getState().dmsAt) return;
  useUnread.setState((s) => ({ dms: { ...s.dms, ...kept.dms }, dmsAt: { ...s.dmsAt, [hub.id]: kept.at } }));
}
