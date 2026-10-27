import { Conversation } from "../chat/conversation";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { Room, RoomMemberRef } from "../hub/types";
import { addressees, MAX_HOPS, memberKey, relay } from "./routing";

/** Where a member's next answer goes: the thread it was asked in, one hop on. */
interface Asked {
  roomId: string;
  threadId: string | null;
  hop: number;
}

const conversations = new Map<string, Conversation>();
const asked = new Map<string, Asked>();

const convoKey = (room: Room, m: RoomMemberRef) => `${memberKey(m)}#${room.slug}`;

const displayName = (m: RoomMemberRef): string =>
  useChat.getState().roster.find((a) => a.hubId === m.hub && a.id === m.agent)?.name ?? m.agent;

const failed = (e: unknown) => useDesk.getState().fail(e);

const conversationFor = (room: Room, m: RoomMemberRef): Conversation | null => {
  const key = convoKey(room, m);
  const existing = conversations.get(key);
  if (existing) return existing;
  const hub = useChat.getState().hubs.find((h) => h.id === m.hub);
  if (!hub) return null;
  const c = new Conversation(hub, m.agent, () => {}, `desk:${room.slug}`, (content) => void answered(room.id, m, content));
  conversations.set(key, c);
  return c;
};

const deliver = (room: Room, m: RoomMemberRef, text: string, threadId: string | null, hop: number) => {
  const c = conversationFor(room, m);
  if (!c) return failed(new Error(`${displayName(m)} is on a hub Desk isn't paired with any more`));
  asked.set(convoKey(room, m), { roomId: room.id, threadId, hop });
  const attempt = (n: number) => {
    if (!c.send(text) && n < 60) setTimeout(() => attempt(n + 1), 250);
  };
  attempt(0);
};

async function answered(roomId: string, m: RoomMemberRef, content: string) {
  const { hub, rooms } = useDesk.getState();
  const room = rooms[roomId];
  const ctx = room && asked.get(convoKey(room, m));
  if (!hub || !room || !ctx) return;
  try {
    await hub.post(room.id, { author: memberKey(m), content, threadId: ctx.threadId, hop: ctx.hop });
  } catch (e) {
    return failed(e);
  }
  if (ctx.hop >= MAX_HOPS) return;
  const next = addressees(content, room.members, useChat.getState().roster, null, memberKey(m));
  for (const n of next) deliver(room, n, relay(room.slug, displayName(m), content), ctx.threadId, ctx.hop + 1);
}

/** You say something in a room: it is kept, then sent to whoever it addresses. */
export async function say(room: Room, text: string, threadId: string | null): Promise<void> {
  const hub = useDesk.getState().hub;
  if (!hub || !text.trim()) return;
  await hub.post(room.id, { author: "you", content: text, threadId });
  for (const m of addressees(text, room.members, useChat.getState().roster, room.defaultMember)) {
    deliver(room, m, relay(room.slug, "you", text), threadId, 0);
  }
}

/** Closes conversations for rooms or members that are gone. */
export function prune(rooms: Record<string, Room>) {
  const live = new Set(Object.values(rooms).flatMap((r) => r.members.map((m) => convoKey(r, m))));
  for (const [key, c] of conversations) {
    if (!live.has(key)) {
      c.close();
      conversations.delete(key);
      asked.delete(key);
    }
  }
}
