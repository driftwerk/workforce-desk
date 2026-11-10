/** How often, at most, Desk tells the hub you're typing in a session's
 *  composer: well inside the shortest hold (the hub's `TYPING_EVERY`). */
export const TYPING_EVERY_MS = 20_000;

/** Tells `hub` you're typing to `sessionId`, if it can be told: a hub
 *  client without `typing` (an older one, a test's), or one that throws or
 *  rejects, changes nothing. Never throws. */
export function pingTyping(hub: { typing?: (sessionId: string) => Promise<void> } | null | undefined, sessionId: string): void {
  if (typeof hub?.typing !== "function") return;
  try {
    void Promise.resolve(hub.typing(sessionId)).catch(() => undefined);
  } catch {
    // Your draft counts once sent, as before.
  }
}

/** A pinger that says "typing" for a session as its draft changes, at most
 *  once every `every` ms per session: your draft counts as your input, so
 *  the boss running it doesn't answer underneath you. An empty draft isn't
 *  typing. */
export function typingPinger(send: (sessionId: string) => void, every = TYPING_EVERY_MS, now: () => number = Date.now) {
  const last = new Map<string, number>();
  return (sessionId: string, draft: string) => {
    if (!draft.trim()) return;
    const at = now();
    const was = last.get(sessionId);
    if (was !== undefined && at - was < every) return;
    last.set(sessionId, at);
    send(sessionId);
  };
}
