/** One viewer of a terminal the hub hosts. A terminal can be shown in more
 *  than one place (a session's card, a grid pane, another window); the hub
 *  lets one viewer at a time type into it and set its size: the *active* one.
 *  The others mirror it at the size the active one set.
 *
 *  A viewer claims the terminal when the person turns to it — focuses it,
 *  types or pastes into it — never because the terminal itself answered a
 *  query (xterm sends those replies as input too), or every mirror would
 *  take the terminal back each time the program asked something. */

export type Dims = { cols: number; rows: number };

export type Control = { type: "resize"; cols: number; rows: number } | { type: "claim" };

export interface ViewerHost {
  /** The size that fits the pane, or null while it has none (a parked pane). */
  propose(): Dims | null;
  /** Sizes the local terminal. */
  resize(d: Dims): void;
  /** Sends a control message to the hub, if the socket is open. */
  send(c: Control): void;
  /** The hub said whether this viewer is active: first, then on each change. */
  role?(active: boolean): void;
}

const usable = (d: Dims | null | undefined): d is Dims =>
  !!d && Number.isFinite(d.cols) && Number.isFinite(d.rows) && d.cols > 0 && d.rows > 0;

export class Viewer {
  private isActive = false;
  /** Whether the hub has said this viewer's role yet. */
  private known = false;
  /** The terminal's size as the hub last said it. */
  private size: Dims | null = null;
  /** The size last asked of the hub, so a box that didn't change asks nothing. */
  private asked: Dims | null = null;

  constructor(private readonly host: ViewerHost) {}

  get active(): boolean {
    return this.isActive;
  }

  /** The socket opened; `focused` when the person is already in this pane. */
  opened(focused: boolean): void {
    this.asked = null;
    if (focused) this.claim();
  }

  /** The person turned to this viewer: make it the active one, at the size
   *  that fits it. A parked pane has no size to offer and claims nothing. */
  claim(): void {
    if (this.isActive) return;
    const d = this.host.propose();
    if (!usable(d)) return;
    this.ask(d);
    this.host.send({ type: "claim" });
  }

  /** The pane's box changed: only the active viewer sizes the terminal. */
  boxChanged(): void {
    if (this.isActive) this.fit();
  }

  /** A control message from the hub (`size` or `role`); others are ignored. */
  heard(m: unknown): void {
    if (!m || typeof m !== "object") return;
    const msg = m as { type?: unknown; cols?: unknown; rows?: unknown; active?: unknown };
    if (msg.type === "size") {
      const d = { cols: Number(msg.cols), rows: Number(msg.rows) };
      if (!usable(d)) return;
      this.size = d;
      if (!this.isActive) this.host.resize(d);
    } else if (msg.type === "role") {
      const was = this.isActive;
      this.isActive = msg.active === true;
      if (this.known && this.isActive === was) return;
      this.known = true;
      if (this.isActive) this.fit();
      else {
        this.asked = null;
        if (this.size) this.host.resize(this.size);
      }
      this.host.role?.(this.isActive);
    }
  }

  private fit(): void {
    const d = this.host.propose();
    if (!usable(d)) return;
    this.host.resize(d);
    this.ask(d);
  }

  private ask(d: Dims): void {
    if (this.asked && this.asked.cols === d.cols && this.asked.rows === d.rows) return;
    this.asked = d;
    this.host.send({ type: "resize", cols: d.cols, rows: d.rows });
  }
}
