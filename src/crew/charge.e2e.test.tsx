// A session a boss runs, end to end against a fake hub: Desk's own client
// over a transport that answers the charge and line routes as the hub does,
// its events socket, and a session's terminal socket. Typing in the pane
// takes the wheel, Hand back gives it back, Release lets the session go and
// Hand to gives it back to the boss.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { GridCanvas } from "../grids/GridView";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { replacePane, startGrids, useGrids } from "../grids/store";
import { useTerminals } from "../grids/terminals";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { ChargeView, DeskEvent, LineMessage, Session } from "../hub/types";
import { Thread } from "../line/Thread";
import { DESK, S1, lined, msg } from "../line/testing";
import { useLine } from "../line/store";
import { useOverview } from "../overview/store";
import { SessionCard } from "../session/SessionCard";
import { useCharges } from "./chargeStore";

const terms: { field?: HTMLTextAreaElement }[] = [];
vi.mock("@xterm/xterm", () => ({
  // Like xterm: its text field takes the keys, and a key the custom handler
  // doesn't keep back is typed.
  Terminal: class {
    cols = 80;
    rows = 24;
    field?: HTMLTextAreaElement;
    buffer = { active: { type: "normal" } };
    options: Record<string, unknown> = {};
    private keys?: (e: KeyboardEvent) => boolean;
    private data?: (d: string) => void;
    constructor() {
      terms.push(this);
    }
    loadAddon() {}
    open(el: HTMLElement) {
      this.field = el.appendChild(document.createElement("textarea"));
      this.field.addEventListener("keydown", (e) => {
        if (this.keys?.(e) === false) return;
        if (e.key.length === 1) this.data?.(e.key);
      });
    }
    write() {}
    reset() {}
    focus() {}
    resize() {}
    dispose() {}
    onData(f: (d: string) => void) {
      this.data = f;
      return { dispose() {} };
    }
    attachCustomKeyEventHandler(f: (e: KeyboardEvent) => boolean) {
      this.keys = f;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { proposeDimensions = () => ({ cols: 80, rows: 24 }); } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

/** A socket the fake hub holds the other end of. */
class Socket implements DeskSocket {
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(private readonly heard: (data: unknown) => void = () => {}) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }
  send(data: unknown) {
    this.heard(data);
  }
  close() {
    this.readyState = 3;
  }
  say(e: DeskEvent) {
    this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent);
  }
}

const SARAH_TELLS = msg({ id: "m-next", from: DESK, to: S1, kind: "tell", text: "Run the payment tests next.", asked: null, delivery: "queued", deliveredAt: null, waiting: "working" });

/** The hub, as far as charges and lines go: one session, its boss Sarah. */
class FakeHub implements DeskTransport {
  charge: ChargeView | null = null;
  thread: LineMessage[] = [];
  requests: string[] = [];
  typed = "";
  events: Socket | null = null;
  session: Session = lined({ state: "working" });

  fetch = async (method: string, path: string, body?: { data: string | Blob }): Promise<Response> => {
    const route = `${method} ${path}`;
    this.requests.push(route);
    const said = body ? (JSON.parse(String(body.data)) as Record<string, unknown>) : {};
    if (route === "GET /api/desk/charges") return json(this.charge ? [this.charge] : []);
    if (route === "GET /api/desk/sessions") return json([this.session]);
    if (route === "GET /api/desk/manager") return json({ agentId: "sarah", level: "act" });
    if (route === "GET /api/desk/sessions/s1/line") return json(this.lineNow());
    if (route === "POST /api/desk/sessions/s1/charge") {
      this.put({ ...charged(), how: "handed" });
      this.note("I'm running this session with the person now. Ask me (to: \"desk\") when you're unsure; they can take over at any time.");
      return json(this.charge);
    }
    if (route === "PATCH /api/desk/sessions/s1/charge") {
      const wheel = said.wheel as ChargeView["wheel"];
      this.put({ ...this.charge!, wheel });
      // What waited goes in once the boss has the wheel again.
      if (wheel === "boss") this.move("queued", "delivered");
      return json(this.charge);
    }
    if (route === "DELETE /api/desk/sessions/s1/charge") {
      if (!this.charge) return json({ error: "No boss runs that session." }, 409);
      this.move("queued", "withdrawn");
      const gone = { ...this.charge, releasedAt: "2026-11-03T10:30:00Z" };
      this.charge = null;
      this.events?.say({ type: "charge", charge: gone });
      this.note("I'm no longer running this session: the person runs it on their own now.");
      return json(gone);
    }
    return new Response("Not Found", { status: 404 });
  };

  socket = (path: string): DeskSocket => {
    if (path === "/api/desk/events") return (this.events = new Socket());
    // The session's terminal: the person's keys reach it, and Desk's hub
    // gives the person the wheel once they type (it looks every few
    // seconds; here, at once).
    return new Socket((data) => {
      if (!ArrayBuffer.isView(data)) return;
      this.typed += new TextDecoder().decode(data);
      if (this.charge?.wheel === "boss") this.put({ ...this.charge, wheel: "person", wheelSince: "2026-11-03T10:20:00Z" });
    });
  };

  /** The thread as the hub reads it: why a queued message waits now. */
  lineNow = (): LineMessage[] =>
    this.thread.map((m) =>
      m.delivery === "queued" && m.from.kind === "manager" ? { ...m, waiting: this.charge && this.charge.wheel !== "boss" ? "person_driving" : "working" } : m,
    );

  put(c: ChargeView) {
    this.charge = c;
    this.events?.say({ type: "charge", charge: c });
  }

  move(from: LineMessage["delivery"], to: LineMessage["delivery"]) {
    this.thread = this.thread.map((m) => {
      if (m.delivery !== from || m.from.kind !== "manager") return m;
      const moved = { ...m, delivery: to, waiting: undefined, deliveredAt: to === "delivered" ? "2026-11-03T10:25:00Z" : null };
      this.events?.say({ type: "line", message: moved });
      return moved;
    });
  }

  note(text: string) {
    const m = msg({ id: `note-${this.thread.length}`, at: "2026-11-03T10:3" + this.thread.length + ":00Z", from: DESK, to: S1, kind: "tell", text, asked: null, delivery: "noted", deliveredAt: null });
    this.thread = [...this.thread, m];
    this.events?.say({ type: "line", message: m });
  }
}

const charged = (): ChargeView => ({
  session: "s1",
  group: null,
  boss: "sarah",
  bossName: "Sarah",
  how: "handed",
  wheel: "boss",
  wheelSince: null,
  since: "2026-11-03T10:00:00Z",
  releasedAt: null,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

let hub: FakeHub;
let disconnect: () => void;

const connect = async () => {
  disconnect = useDesk.getState().connect(hub);
  await act(async () => {
    await Promise.resolve();
    hub.events!.say({ type: "snapshot", sessions: [hub.session], restore: [], rooms: [] });
  });
  await waitFor(() => expect(useCharges.getState().supported).toBe(true));
};

function Pane() {
  const g = useGrids((s) => s.grids[MAIN_GRID]!);
  return <GridCanvas grid={g} />;
}

beforeEach(() => {
  terms.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  hub = new FakeHub();
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  useTerminals.setState({ byId: {}, known: true, programs: {}, problems: {} });
  useCharges.setState({ bySession: {}, supported: null });
  useLine.setState({ threads: {}, problems: {} });
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }],
    roster: [{ hubId: "local", id: "sarah", name: "Sarah", model: null, provider: null, isDefault: true }],
  });
  useOverview.setState({ manager: { agentId: "sarah", level: "act" }, managerSupport: "yes", overviewSupport: "no", suggestions: {}, suggestionsLoaded: true });
});
afterEach(() => {
  disconnect?.();
  cleanup();
  vi.unstubAllGlobals();
});

describe("a session Sarah runs", () => {
  it("is yours to drive once you type in its pane, Sarah's message waiting until you hand it back", async () => {
    hub.charge = charged();
    hub.thread = [SARAH_TELLS];
    await connect();
    act(() => replacePane(MAIN_GRID, useGrids.getState().grids[MAIN_GRID]!.panes[0]!.id, { kind: "session", sessionId: "s1" }));
    render(
      <>
        <Pane />
        <Thread session={useDesk.getState().sessions.s1!} />
      </>,
    );
    const pane = screen.getByRole("region", { name: "acme-web" });
    expect(within(pane).getByText("Sarah has it")).toBeTruthy();
    expect(await screen.findByText(/Waiting for it to finish its turn/)).toBeTruthy();

    // You type in the pane: the keys reach the session, and it's yours.
    const field = terms.at(-1)!.field!;
    await act(async () => {
      fireEvent.keyDown(field, { key: "y" });
      await Promise.resolve();
    });
    expect(hub.typed).toBe("y");
    await waitFor(() => expect(within(pane).getByText("You’re driving")).toBeTruthy());
    expect(within(pane).queryByText("Sarah has it")).toBeNull();
    // Why Sarah's message waits is read again with the wheel.
    expect(await screen.findByText(/Waiting: you're driving/)).toBeTruthy();

    // Hand back, from the pane's header: Sarah has it, and her message goes in.
    await act(async () => fireEvent.click(within(pane).getByRole("button", { name: "Hand back" })));
    expect(hub.requests).toContain("PATCH /api/desk/sessions/s1/charge");
    await waitFor(() => expect(within(pane).getByText("Sarah has it")).toBeTruthy());
    expect(await screen.findByText(/Delivered/)).toBeTruthy();
    expect(screen.queryByText(/Waiting: you're driving/)).toBeNull();
  });

  it("is released from its card, what Sarah held is withdrawn, and handed back to her from the pane's menu", async () => {
    hub.charge = charged();
    hub.thread = [SARAH_TELLS];
    await connect();
    act(() => replacePane(MAIN_GRID, useGrids.getState().grids[MAIN_GRID]!.panes[0]!.id, { kind: "session", sessionId: "s1" }));
    render(
      <>
        <Pane />
        <SessionCard session={useDesk.getState().sessions.s1!} />
      </>,
    );
    const card = screen.getByRole("complementary", { name: "Session acme-web" });
    const strip = within(card).getByRole("status", { name: "Who runs acme-web" });
    expect(within(strip).getByText("Sarah has it")).toBeTruthy();
    expect(within(strip).getByText(/Sarah runs this session/)).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Hand to Sarah" })).toBeNull();

    expect(await within(card).findByText(/Waiting for it to finish its turn/)).toBeTruthy();
    await act(async () => fireEvent.click(within(strip).getByRole("button", { name: "Release" })));
    expect(hub.requests).toContain("DELETE /api/desk/sessions/s1/charge");
    await waitFor(() => expect(within(card).queryByRole("status", { name: "Who runs acme-web" })).toBeNull());
    const pane = screen.getByRole("region", { name: "acme-web" });
    expect(within(pane).queryByText("Sarah has it")).toBeNull();
    expect(await within(card).findByText(/Not delivered: Sarah no longer runs it/)).toBeTruthy();
    expect(within(card).getByText(/I'm no longer running this session/)).toBeTruthy();
    expect(within(card).getAllByText(/A note here only: not typed in/).length).toBeGreaterThan(0);

    // The card offers it to Sarah again; here, back to her from the pane's menu.
    expect(within(card).getByRole("button", { name: "Hand to Sarah" })).toBeTruthy();
    await act(async () => fireEvent.click(within(pane).getByRole("button", { name: "Pane options" })));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Hand to Sarah" })));
    expect(hub.requests.filter((r) => r === "POST /api/desk/sessions/s1/charge")).toHaveLength(1);
    await waitFor(() => expect(within(pane).getByText("Sarah has it")).toBeTruthy());
    expect(within(card).getByRole("status", { name: "Who runs acme-web" })).toBeTruthy();
  });

  it("says the hub's refusal in its own words", async () => {
    await connect();
    render(<SessionCard session={useDesk.getState().sessions.s1!} />);
    hub.fetch = async () => json({ error: "Sarah only watches; set them to Act to run work." }, 409);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Hand to Sarah" })));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Sarah only watches; set them to Act to run work."));
  });
});
