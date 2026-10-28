import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { useDesk } from "../hub/store";

/** The key of an agent on this Mac (the overview lists only those). */
export const localKey = (id: string): string | null => {
  const hub = useChat.getState().hubs.find((h) => h.local);
  return hub ? `${hub.id}/${id}` : null;
};

/** An agent on this Mac, by id, once the roster has it. */
export const useLocalAgent = (id: string | null | undefined): Agent | undefined => {
  const hub = useChat((s) => s.hubs.find((h) => h.local));
  return useChat((s) => (id && hub ? s.roster.find((a) => a.hubId === hub.id && a.id === id) : undefined));
};

/** Opens your DM with an agent on this Mac. */
export const openLocalDm = (id: string): void => {
  const key = localKey(id);
  if (!key || !useChat.getState().roster.some((a) => agentKey(a) === key)) return;
  void useDesk.getState().openRoom(null);
  useChat.getState().openDm(key);
};

/** Whether Desk lists the session, so its card can open. */
export const useKnownSession = (id: string | null | undefined): boolean => useDesk((s) => !!id && !!s.sessions[id]);

/** Opens a session's card, if Desk lists it (else it would open nothing). */
export const openSession = (id: string): void => {
  if (useDesk.getState().sessions[id]) useDesk.getState().open(id);
};
