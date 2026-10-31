import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import { useDesk } from "../hub/store";
import { openTarget } from "../shell/navigate";

/** The key of an agent on this computer (the overview lists only those). */
export const localKey = (id: string): string | null => {
  const hub = useChat.getState().hubs.find((h) => h.local);
  return hub ? `${hub.id}/${id}` : null;
};

/** An agent on this computer, by id, once the roster has it. */
export const useLocalAgent = (id: string | null | undefined): Agent | undefined => {
  const hub = useChat((s) => s.hubs.find((h) => h.local));
  return useChat((s) => (id && hub ? s.roster.find((a) => a.hubId === hub.id && a.id === id) : undefined));
};

/** Opens your DM with an agent on this computer: beside the Floor, where
 *  everything clicked on it opens, even when a grid shows it. */
export const openLocalDm = (id: string): void => {
  const key = localKey(id);
  if (key) openTarget({ kind: "agent", key }, { beside: true });
};

/** Whether Desk lists the session, so its card can open. */
export const useKnownSession = (id: string | null | undefined): boolean => useDesk((s) => !!id && !!s.sessions[id]);

/** Opens a session's card beside the Floor, even when a grid shows it, if
 *  Desk lists it (else it would open nothing). */
export const openSession = (id: string): void => openTarget({ kind: "session", sessionId: id }, { beside: true });
