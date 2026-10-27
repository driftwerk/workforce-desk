import type { Agent } from "../chat/types";

export interface RoomMember {
  hub: string;
  agent: string;
}

export const memberKey = (m: RoomMember): string => `${m.hub}/${m.agent}`;

export const MAX_HOPS = 3;

/** Members a message addresses: every `@name` (or `@name@hub`) that names a
 *  member, else the room's default member. */
export const addressees = (
  text: string,
  members: RoomMember[],
  roster: Agent[],
  defaultMember: string | null,
  exclude?: string,
): RoomMember[] => {
  const named = (m: RoomMember) => roster.find((a) => a.hubId === m.hub && a.id === m.agent)?.name ?? m.agent;
  const mentions = [...text.matchAll(/@([\w.-]+)(?:@([\w.-]+))?/g)].map((x) => ({
    name: x[1]!.toLowerCase(),
    hub: x[2]?.toLowerCase(),
  }));
  const hit = members.filter((m) =>
    mentions.some(
      (x) => (x.name === m.agent.toLowerCase() || x.name === named(m).toLowerCase()) && (!x.hub || x.hub === m.hub.toLowerCase()),
    ),
  );
  const chosen = hit.length ? hit : members.filter((m) => memberKey(m) === defaultMember);
  return chosen.filter((m) => memberKey(m) !== exclude);
};

/** What a member is sent: who said it and where, so a per-room conversation
 *  reads as the room. */
export const relay = (room: string, from: string, text: string): string => `[#${room}] ${from}: ${text}`;
