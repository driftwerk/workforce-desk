import type { DeliveryKind, DeskPlace, HubAccount, ServerMessage } from "../chat/types";
import { pairedHub } from "../hub/net";
import { backoff, detach, keepAlive } from "../hub/socket";
import type { DeskSocket } from "../hub/transport";
import { whoAmI } from "./pairing";

// The hub link: one socket per paired hub (`/ws/desk`), over which the hub
// says one of your conversations gained a message outside a live turn — a
// reminder, a job's answer, a workflow's step — and that your floor or your
// plans' usage changed. Nothing rides it but the signal: the conversation is
// drained by cursor, and the floor read again, on every `hello` (whatever
// changed while the link was down) and on every signal.

/** A message a hub delivered into one of your conversations. */
export interface Delivered {
  agentId: string;
  channel: string;
  sessionId: string;
  messageId: string;
  kind: DeliveryKind;
  place: DeskPlace;
  spoken: boolean;
}

/** Why a hub has no link for Desk: it is too old to have one, or this computer
 *  is paired to it as nobody (`link_requires_identity`). */
export type Unlinked = "legacy" | "unlinked";

/** What a hub says changed of yours, beyond your conversations: its
 *  floor, plans' usage, or how far you've read a DM (on another Desk). */
export type Changed = "floor" | "usage" | "reads";

const CHANGED: Record<string, Changed> = { floor_changed: "floor", usage_changed: "usage", read_changed: "reads" };

export interface LinkEvents {
  hello: (features: ReadonlySet<string>) => void;
  delivered: (d: Delivered) => void;
  changed: (what: Changed) => void;
  /** The link dropped: until its next `hello`, nothing it would say is heard. */
  closed: () => void;
  unavailable: (why: Unlinked) => void;
}

/** The link's socket on a hub. It names no token: the native side puts
 *  the hub's in the handshake's header. */
export const LINK_PATH = "/ws/desk";

/** Why a link that wouldn't open didn't: the route is missing, the hub
 *  takes this computer for nobody, or neither (try again). A socket can't say
 *  how its upgrade was refused, so the hub is asked over HTTP. */
export const probeLink = async (hub: HubAccount): Promise<Unlinked | null> => {
  try {
    const res = await pairedHub(hub).fetch("GET", LINK_PATH);
    const page = res.ok && !(res.headers.get("content-type") ?? "").includes("json");
    if (res.status === 404 || page) return "legacy";
  } catch {
    return null;
  }
  return (await whoAmI(hub)).state === "nobody" ? "unlinked" : null;
};

const delivered = (m: ServerMessage): Delivered | null =>
  m.agent_id && m.channel && m.session_id && m.message_id && m.kind && m.place
    ? {
        agentId: m.agent_id,
        channel: m.channel,
        sessionId: m.session_id,
        messageId: m.message_id,
        kind: m.kind,
        place: m.place,
        spoken: m.spoken ?? false,
      }
    : null;

/** One hub's link, reconnecting with the same back-off as a conversation
 *  until closed, or until the hub turns out to have none. */
export class HubLink {
  private ws: DeskSocket | null = null;
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private alive: ReturnType<typeof keepAlive> | undefined;

  constructor(
    readonly hub: HubAccount,
    private readonly events: LinkEvents,
    private readonly probe: (hub: HubAccount) => Promise<Unlinked | null> = probeLink,
  ) {
    this.open();
  }

  private open() {
    const ws = pairedHub(this.hub).socket(LINK_PATH);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.retry = 0;
      this.alive = keepAlive(ws);
    };
    ws.onmessage = (e) => {
      this.alive?.heard();
      let m: ServerMessage;
      try {
        m = JSON.parse(e.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (m.type === "hello") this.events.hello(new Set(m.features ?? []));
      const d = m.type === "desk_delivered" ? delivered(m) : null;
      if (d) this.events.delivered(d);
      const changed = CHANGED[m.type];
      if (changed) this.events.changed(changed);
    };
    ws.onclose = () => {
      this.alive?.stop();
      if (this.closed) return;
      if (opened) this.events.closed();
      void (opened ? Promise.resolve(null) : this.probe(this.hub)).then((why) => {
        if (this.closed) return;
        if (why) return this.events.unavailable(why);
        this.timer = setTimeout(() => this.open(), backoff(this.retry++));
      });
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.alive?.stop();
    detach(this.ws);
  }
}
