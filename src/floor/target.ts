import type { Need, Place, Room } from "../hub/types";
import type { Target } from "../shell/navigate";
import type { OnHub } from "./needs";

const slackUrl = (place: Extract<Place, { kind: "slack" }>): string =>
  `https://slack.com/app_redirect?${new URLSearchParams({ ...(place.team ? { team: place.team } : {}), channel: place.channel })}`;

/** Where an item opens: one of this computer's sessions in its pane or card
 *  (another hub's opens nowhere here); a room (or its thread) this computer
 *  has; Slack where the turn was; else the agent's DM. */
export const targetOf = (item: OnHub & Pick<Need, "who" | "place">, rooms: Readonly<Record<string, Room>>): Target | null => {
  if (item.who.kind === "session") return item.local ? { kind: "session", sessionId: item.who.id } : null;
  const dm: Target = { kind: "agent", key: `${item.hubId}/${item.who.id}` };
  switch (item.place.kind) {
    case "room":
      return rooms[item.place.room] ? { kind: "room", roomId: item.place.room, threadId: item.place.thread } : dm;
    case "slack":
      return { kind: "slack", url: slackUrl(item.place) };
    default:
      return dm;
  }
};

/** Where it was, when that isn't the DM or the session itself. */
export const placeLabel = (place: Place, rooms: Readonly<Record<string, Room>>): string | null => {
  switch (place.kind) {
    case "room":
      return rooms[place.room] ? `in ${rooms[place.room]!.name}` : "in a room on another computer";
    case "call":
      return "in a call";
    case "slack":
      return "in Slack";
    default:
      return null;
  }
};
