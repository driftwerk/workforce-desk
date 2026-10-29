// Puts back what was open before the shell first renders, then keeps it:
// every change goes to Desk's file at once and to the hub shortly after, and
// is flushed when the window loses focus, hides or unloads. The hub is asked
// again each time its connection comes back (a hub restart), which is also
// when its state store is first found and the file's contents sent to it.

import type { DeskHub } from "../hub/client";
import { deskListeners, useDesk } from "../hub/store";
import {
  onNativeState,
  stateAdopt,
  stateFlush,
  stateLoad,
  statePut,
  stateRemove,
  stateSynced,
  subscribe as listenerCleanup,
} from "../platform";
import { DeskStateStore, stable, type HubState, type LocalState } from "./store";

/** Something shown that Desk restores under one key: what it is now, how to
 *  show a saved one, and when it changes. */
export interface Restorable {
  key: string;
  read: () => unknown;
  write: (value: unknown) => void;
  subscribe: (onChange: () => void) => () => void;
}

const local: LocalState = {
  load: stateLoad,
  put: statePut,
  remove: stateRemove,
  synced: stateSynced,
  adopt: stateAdopt,
  flush: stateFlush,
};

export const hubState = (hub: DeskHub): HubState => ({ list: hub.stateList, put: hub.statePut, remove: hub.stateRemove });

/** The one store of what Desk restores. */
export const deskState = new DeskStateStore(local);

/** Shows what was saved under `r.key` (if anything) and keeps it from then
 *  on; a value the hub replaces it with is shown too. */
export function restore(store: DeskStateStore, r: Restorable): () => void {
  const saved = store.get(r.key);
  if (saved !== undefined) r.write(saved);
  let last = stable(r.read());
  const stopLocal = r.subscribe(() => {
    const now = r.read();
    const s = stable(now);
    if (s === last) return;
    last = s;
    store.set(r.key, now);
  });
  const stopHub = store.watch(r.key, (v) => {
    if (v === null) return;
    r.write(v);
    last = stable(r.read());
  });
  return () => {
    stopLocal();
    stopHub();
  };
}

/** Keeps `store` on the hub `useDesk` is connected to, through restarts. */
export function followHub(store: DeskStateStore): () => void {
  const onEvent = (e: import("../hub/types").DeskEvent) => {
    if (e.type === "state") void store.heard(e.key, e.value);
  };
  deskListeners.add(onEvent);
  const stop = useDesk.subscribe((s, before) => {
    if (s.connected && s.hub && (!before.connected || s.hub !== before.hub)) void store.connect(hubState(s.hub));
    if (!s.hub && before.hub) void store.connect(null);
  });
  const now = useDesk.getState();
  if (now.connected && now.hub) void store.connect(hubState(now.hub));
  return () => {
    deskListeners.delete(onEvent);
    stop();
  };
}

/** Writes what's pending whenever Desk might be about to go away. */
export function flushOnLeave(store: DeskStateStore): () => void {
  const flush = () => void store.flush();
  const onVisibility = () => document.visibilityState === "hidden" && flush();
  window.addEventListener("blur", flush);
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("blur", flush);
    window.removeEventListener("pagehide", flush);
    window.removeEventListener("beforeunload", flush);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** How long the shell waits for Desk's file before rendering without it. */
const LOAD_WAIT_MS = 1500;

/** Reads Desk's file and shows what was open, then keeps everything in
 *  `restorables` saved (until the returned function is called). Never
 *  throws: Desk opens on its defaults if the file can't be read. */
export async function restoreBeforeRender(restorables: Restorable[], store = deskState): Promise<() => void> {
  try {
    await Promise.race([
      store.load(),
      new Promise((_, fail) => setTimeout(() => fail(new Error("timed out")), LOAD_WAIT_MS)),
    ]);
  } catch (e) {
    console.warn("couldn't read what Desk had open:", e);
  }
  const stops: (() => void)[] = [];
  for (const r of restorables) {
    try {
      stops.push(restore(store, r));
    } catch (e) {
      console.warn(`couldn't restore ${r.key}:`, e);
    }
  }
  stops.push(listenerCleanup(onNativeState((changes) => store.native(changes))), flushOnLeave(store), followHub(store));
  return () => stops.forEach((s) => s());
}
