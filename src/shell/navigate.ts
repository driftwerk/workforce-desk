import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { reveal } from "../grids/windows";
import { sessionOf, type ItemKey } from "../groups/model";
import { useDesk } from "../hub/store";
import { openUrl } from "../platform";
import { openAgent, openAgentBeside } from "../rooms/AgentPanel";
import { requestFocus } from "./focus";
import { useUi } from "./ui";

/** Somewhere Desk can take the person: a session, a DM, a room (or one of
 *  its threads), or a Slack conversation. */
export type Target =
  | { kind: "session"; sessionId: string }
  | { kind: "agent"; key: string }
  | { kind: "room"; roomId: string; threadId: string | null }
  | { kind: "slack"; url: string };

/** The composer or terminal a target types into. */
export const focusKeyOf = (t: Target): string | null => {
  switch (t.kind) {
    case "session":
      return `session:${t.sessionId}`;
    case "agent":
      return `agent:${t.key}`;
    case "room":
      return t.threadId ? `room:${t.roomId}/${t.threadId}` : `room:${t.roomId}`;
    case "slack":
      return null;
  }
};

const openRoom = async (roomId: string, threadId: string | null): Promise<boolean> => {
  const desk = useDesk.getState();
  await desk.openRoom(roomId);
  const known = () => !!threadId && !!useDesk.getState().timelines[roomId]?.some((m) => m.id === threadId || m.threadId === threadId);
  // A thread older than the room's latest page is read before it's taken
  // for gone; one that's gone leaves the room's main timeline showing.
  const seen = known();
  if (threadId && !seen) await desk.openThread(roomId, threadId);
  const thread = known() ? threadId : null;
  useUi.getState().setRoomThread(roomId, thread);
  if (thread && seen) await desk.openThread(roomId, thread);
  return thread === threadId;
};

/** Takes the person to `t`: where it shows in a grid, else where it opens;
 *  with `beside`, a session's card or an agent's DM opens beside the Floor
 *  even when a grid shows it (the card says where, with a way there); with
 *  `reply`, its composer (or terminal) takes focus. */
export const openTarget = (t: Target, opts: { reply?: boolean; beside?: boolean } = {}): void => {
  const focus = (key: string | null) => opts.reply && key && requestFocus(key);
  switch (t.kind) {
    case "session": {
      if (!useDesk.getState().sessions[t.sessionId]) return;
      if (opts.beside || !reveal({ kind: "session", sessionId: t.sessionId })) useDesk.getState().open(t.sessionId);
      return void focus(focusKeyOf(t));
    }
    case "agent": {
      if (!useChat.getState().roster.some((a) => agentKey(a) === t.key)) return;
      (opts.beside ? openAgentBeside : openAgent)(t.key);
      return void focus(focusKeyOf(t));
    }
    case "room":
      void openRoom(t.roomId, t.threadId).then((exact) => focus(focusKeyOf(exact ? t : { ...t, threadId: null })));
      return;
    case "slack":
      return openUrl(t.url);
  }
};

/** Where a sidebar item opens. */
export const targetOfItem = (key: ItemKey): Target | null => {
  const session = sessionOf(key);
  if (session) return { kind: "session", sessionId: session };
  return key.startsWith("agent:") ? { kind: "agent", key: key.slice("agent:".length) } : null;
};
