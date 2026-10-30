import { useChat } from "../chat/store";
import type { DeliveryKind } from "../chat/types";
import { shownState } from "../floor/background";
import { useDesk } from "../hub/store";
import type { DeskEvent, Room, RoomMessage, SessionState, Urgency } from "../hub/types";
import { notificationFor, notify } from "../shell/notify";
import type { Place } from "./places";
import { levelOf, type NotifyLevel } from "./prefs";
import { laterPoint, pointOf } from "./reads";

// One gate for every notification Desk sends: a session, a DM, a room.
// Each place's level says what may interrupt you; the main window alone
// sends, only while Desk isn't in front, each item once, and never one a
// read point already covers (another Desk of yours read it first).

export interface Notice {
  place: Place;
  urgency: Urgency;
  /** What it's about, sent once. */
  id: string;
  title: string;
  body: string;
  /** An answer to an ask that took under a minute: you were likely watching. */
  quick?: boolean;
  /** A job's, workflow's or check-in's delivery: for you, but not worth
   *  interrupting you for unless you asked for everything. */
  quiet?: boolean;
  /** When what it's about happened, on its hub's clock. */
  at?: string;
}

/** An answer to your ask quicker than this doesn't interrupt you. */
export const QUICK_MS = 60_000;

/** Deliveries that badge as for you but interrupt only at All. */
export const QUIET: ReadonlySet<DeliveryKind> = new Set<DeliveryKind>(["job", "workflow", "check_in"]);

/** Whether `n` interrupts at `level`: Off never; Only things for me for
 *  needs and for-you items that are neither quick nor quiet; All always. */
export const interrupts = (n: Notice, level: NotifyLevel): boolean =>
  level === "all" || (level === "mine" && n.urgency !== "new" && !n.quick && !n.quiet);

const sent = new Set<string>();

/** Sends `n` if it may interrupt you, from the main window, once. */
export function notifyPlace(n: Notice): void {
  if (useDesk.getState().detached || sent.has(n.id)) return;
  if (!interrupts(n, levelOf(n.place))) return;
  const read = pointOf(n.place);
  if (n.at && read && !laterPoint({ at: n.at, message: null }, read)) return;
  sent.add(n.id);
  void notify({ title: n.title, body: n.body });
}

/** What a delivery is called when you're told of it. */
export const DELIVERY_LABEL: Partial<Record<DeliveryKind, string>> = {
  reminder: "Reminder",
  job: "Scheduled job",
  workflow: "Workflow",
  approval: "Needs your approval",
  check_in: "Check-in",
};

/** A notice's first line of text, short. */
export const firstLine = (text: string): string => text.split("\n").find((l) => l.trim())?.trim().slice(0, 200) ?? "";

/** A delivery kept in one of your rooms. */
const delivered = (room: Room | undefined, m: RoomMessage) => {
  if (!room || !m.delivery) return;
  const [hub, agent] = m.author.split("/");
  const who = useChat.getState().roster.find((a) => a.hubId === hub && a.id === agent)?.name ?? agent ?? m.author;
  notifyPlace({
    place: m.threadId ? { kind: "thread", room: room.id, thread: m.threadId } : { kind: "room", room: room.id },
    urgency: m.delivery === "notice" ? "new" : "forYou",
    quiet: QUIET.has(m.delivery),
    id: `room:${m.id}`,
    at: m.createdAt,
    title: `${who} · ${DELIVERY_LABEL[m.delivery] ?? "Message"} · ${room.name}`,
    body: firstLine(m.content),
  });
};

/** What each session showed last, to tell a change from a repeat. */
const shownBefore = new Map<string, SessionState>();

/** The events socket's part: a session that starts needing you or
 *  finishes, and a delivery into one of your rooms. */
export function noticesFrom(e: DeskEvent): void {
  if (e.type === "snapshot") for (const s of e.sessions) shownBefore.set(s.id, shownState(s));
  if (e.type === "session") {
    const state = shownState(e.session);
    const n = notificationFor(shownBefore.get(e.session.id), e.session);
    shownBefore.set(e.session.id, state);
    if (n)
      notifyPlace({
        ...n,
        place: { kind: "session", session: e.session.id },
        urgency: state === "blocked" ? "needs" : "forYou",
        id: `session:${e.session.id}:${state}:${e.session.updatedAt}`,
      });
  }
  if (e.type === "roomMessage" && e.message.delivery) delivered(useDesk.getState().rooms[e.message.roomId], e.message);
}

/** For a test: forget what was sent. */
export const resetSent = (): void => sent.clear();
