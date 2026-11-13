import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import { attending, useDeskFocus } from "./focus";
import { useWatching } from "./watching";

// Whether you're in front of Desk, and which boss's DM is on screen, told
// to this computer's hub: it holds the boss's updates for your return and
// sends one catch-up when the DM is back in front of you. Hours spent in
// session terminals with the DM unread count as away: the hub judges that
// from how far you've read the DM, and this only says the moment it is on
// screen again. The main window alone tells, on every change and each
// minute; a hub that stops hearing goes by the read point alone.

/** How often, at least, the hub is told. */
export const PRESENCE_EVERY_MS = 60_000;

/** The agent of this computer's hub whose DM is on screen in `on` (places
 *  by key, as `useWatching` keeps them), or null. */
export function dmOnScreen(on: Readonly<Record<string, number>>, localHub: string | undefined): string | null {
  if (!localHub) return null;
  const prefix = `dm:${localHub}/`;
  for (const [key, n] of Object.entries(on)) {
    if (n > 0 && key.startsWith(prefix)) return key.slice(prefix.length) || null;
  }
  return null;
}

/** Tells the hub of your presence until the returned stop is called. */
export function sharePresence(every = PRESENCE_EVERY_MS): () => void {
  if (useDesk.getState().detached) return () => {};
  let last = "";
  const tell = (always: boolean) => {
    const hub = useDesk.getState().hub;
    // A hub client without it (a test's) is told nothing.
    if (typeof hub?.presence !== "function") return;
    const here = attending();
    const dm = here ? dmOnScreen(useWatching.getState().on, useChat.getState().hubs.find((h) => h.local)?.id) : null;
    const now = `${here}:${dm ?? ""}`;
    if (!always && now === last) return;
    last = now;
    void Promise.resolve(hub.presence(here, dm)).catch(() => undefined);
  };
  const changed = () => tell(false);
  const stops = [
    useWatching.subscribe((s, before) => {
      if (s.on !== before.on) changed();
    }),
    useDeskFocus.subscribe(changed),
    useDesk.subscribe((s, before) => {
      if (s.hub !== before.hub) tell(true);
    }),
  ];
  window.addEventListener("focus", changed);
  window.addEventListener("blur", changed);
  document.addEventListener("visibilitychange", changed);
  const timer = setInterval(() => tell(true), every);
  tell(true);
  return () => {
    stops.forEach((s) => s());
    window.removeEventListener("focus", changed);
    window.removeEventListener("blur", changed);
    document.removeEventListener("visibilitychange", changed);
    clearInterval(timer);
  };
}
