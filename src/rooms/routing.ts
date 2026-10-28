import type { Agent, HubAccount } from "../chat/types";
import { resolveMentions } from "./mentions";

export interface RoomMember {
  hub: string;
  agent: string;
}

export const memberKey = (m: RoomMember): string => `${m.hub}/${m.agent}`;

export const MAX_HOPS = 3;

/** Members a message addresses: every member an `@name` (or `@name@hub`)
 *  names, else the room's default member. Never anyone outside the room:
 *  bringing someone in is yours to do (`say`), not an agent's. */
export const addressees = (
  text: string,
  members: RoomMember[],
  roster: Agent[],
  defaultMember: string | null,
  exclude?: string,
  hubs: readonly HubAccount[] = [],
): RoomMember[] => {
  const hit = resolveMentions(text, members, roster, hubs).members;
  const chosen = hit.length ? hit : members.filter((m) => memberKey(m) === defaultMember);
  return chosen.filter((m) => memberKey(m) !== exclude);
};

/** What a member is sent: who said it and where, so a per-room conversation
 *  reads as the room. */
export const relay = (room: string, from: string, text: string): string => `[#${room}] ${from}: ${text}`;
