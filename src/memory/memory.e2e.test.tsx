// Desk Memory end to end against a fake hub: Desk's own client over a
// transport that keeps a session's memory, its notes and the person's
// switches as the hub does. Atlas-api, in Acme, is opened on its Memory tab:
// Desk asks once whether its model may read Acme's sessions, and the answer
// lets notes come; one is confirmed and one corrected (the old one shows as
// replaced); remembering is turned off for it; and what Desk remembers is
// forgotten. Acme's own switches are set from the sidebar, and remembering is
// paused in Settings.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_GRID } from "../grids/model";
import type { GridStorage } from "../grids/storage";
import { startGrids, useGrids } from "../grids/store";
import { useTerminals } from "../grids/terminals";
import { useHubLayout } from "../groups/hubLayout";
import type { Layout } from "../groups/model";
import { SidebarGroups } from "../groups/SidebarGroups";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { DeskEvent, MemoryNote, ReplacedNote } from "../hub/types";
import { useOverview } from "../overview/store";
import { SessionCard } from "../session/SessionCard";
import { Memory } from "../settings/Memory";
import { useSettings } from "../settings/store";
import { EMPTY_LAYOUT } from "../groups/model";
import { indexOf, note, notes, remembered, sessionOf, settingsOf } from "./testing";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("../session/Terminal", () => ({ Terminal: () => null }));

class Socket implements DeskSocket {
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  say(e: DeskEvent) {
    this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent);
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const GROUP_OFF = "Desk doesn't note decisions, facts or to-dos from this group's sessions until you let its model read them, in the group's settings.";

/** The hub, as far as Desk Memory goes. */
class FakeHub implements DeskTransport {
  requests: string[] = [];
  events: Socket | null = null;
  layout: Layout = {
    groups: [{ id: "g-acme", name: "Acme", collapsed: false, items: ["session:s1"] }],
    ungrouped: { collapsed: false, items: [] },
  };
  settings = settingsOf();
  memoryOn = true;
  forgotten = false;
  derives = 0;
  /** What its model would note once Acme lets it. */
  noted: MemoryNote[] = [note("d1", "decision", "Keep the session token in a secure cookie."), note("f1", "fact", "Sessions live in Redis.")];
  kept: MemoryNote[] = [];
  replaced: ReplacedNote[] = [];

  memory = () => {
    const acme = this.settings.groups[0]!;
    const paused = this.settings.paused;
    const off = !this.memoryOn || paused;
    // A session Desk still has: what it remembers is gone, and it isn't
    // remembered again.
    if (this.forgotten)
      return remembered({
        exchanges: [],
        counts: { exchanges: 0, open: 0, compactions: 0, secretsHidden: 0, pastCap: 0 },
        remembering: false,
        why: "You asked Desk to forget this conversation.",
        memoryOn: this.memoryOn,
        lastRead: null,
        switches: { paused: this.settings.paused, group: this.settings.groups[0]! },
        notes: notes([]),
      });
    return remembered({
      remembering: !off,
      why: paused ? "Remembering is paused for every session." : !this.memoryOn ? "Remembering is off for this session." : null,
      memoryOn: this.memoryOn,
      switches: { paused, group: acme },
      notes: notes(this.kept, {
        replaced: this.replaced,
        counts: {
          decisions: this.kept.filter((n) => n.kind === "decision").length,
          facts: this.kept.filter((n) => n.kind === "fact").length,
          todos: 0,
          openTodos: 0,
          kept: this.kept.length + this.replaced.length,
        },
        ...(paused
          ? { noting: "off", reason: "paused", why: "Desk isn't noting decisions while remembering is paused for every session." }
          : off
          ? { noting: "off", reason: "session_off", why: "Desk isn't noting decisions while it isn't remembering this session." }
          : !acme.derive
            ? { noting: "off", reason: "group_off", why: GROUP_OFF }
            : {}),
      }),
    });
  };

  fetch = async (method: string, path: string, body?: { data: string | Blob }): Promise<Response> => {
    const route = `${method} ${path}`;
    this.requests.push(route);
    const sent = body ? (JSON.parse(String(body.data)) as Record<string, unknown>) : {};
    if (route === "GET /api/desk/sessions") return json([sessionOf()]);
    if (route === "GET /api/desk/layout") return json(this.layout);
    if (route === "GET /api/desk/manager") return json({ agentId: "desk", level: "act", bosses: [], sealed: [] });
    if (route === "GET /api/desk/sessions/s1/memory") {
      const m = this.memory();
      return m ? json(m) : json({ error: "not found" }, 404);
    }
    if (route === "POST /api/desk/sessions/s1/memory/derive") {
      this.derives++;
      // The model reads once the group allows it.
      if (this.settings.groups[0]!.derive && this.memoryOn && !this.forgotten && this.kept.length === 0 && this.replaced.length === 0) this.kept = [...this.noted];
      return new Response(null, { status: 202 });
    }
    if (route === "PATCH /api/desk/sessions/s1/memory") {
      this.memoryOn = sent.on as boolean;
      return new Response(null, { status: 204 });
    }
    if (route === "DELETE /api/desk/sessions/s1/memory") {
      this.forgotten = true;
      return new Response(null, { status: 204 });
    }
    const item = /^\/api\/desk\/memory\/items\/([^/]+)$/.exec(path);
    if (item && method === "PATCH") {
      const was = this.kept.find((n) => n.id === item[1]);
      if (!was) return json({ error: "That note was replaced or dropped already." }, 409);
      if (sent.action === "confirm") {
        Object.assign(was, { confirmed: true });
        return json({ item: was });
      }
      if (sent.action === "correct") {
        const now = note(`${was.id}b`, was.kind, sent.text as string, { notedByDesk: false, confirmed: true });
        this.kept = this.kept.map((n) => (n === was ? now : n));
        this.replaced = [{ id: was.id, kind: was.kind, text: was.text, replacedAt: new Date().toISOString() }, ...this.replaced];
        return json({ item: now });
      }
      this.kept = this.kept.filter((n) => n !== was);
      return new Response(null, { status: 204 });
    }
    if (route === "GET /api/desk/memory/settings") return json(this.settings);
    if (route === "PATCH /api/desk/memory/settings") {
      this.settings = { ...this.settings, paused: sent.paused as boolean };
      this.events?.say({ type: "setting", key: "memory.paused" });
      return json(this.settings);
    }
    const group = /^\/api\/desk\/memory\/groups\/([^/]+)$/.exec(path);
    if (group && method === "PATCH") {
      const g = this.settings.groups.find((x) => x.id === group[1]);
      if (!g) return json({ error: "not found" }, 404);
      const { id: _id, name: _name, ...now } = { ...g, ...sent, deriveDecided: g.deriveDecided || "derive" in sent };
      this.settings = { ...this.settings, groups: this.settings.groups.map((x) => (x === g ? { ...x, ...now } : x)) };
      this.events?.say({ type: "setting", key: `memory.group.${g.id}` });
      return json(now);
    }
    if (route === "GET /api/desk/memory/index") return json(indexOf());
    return new Response("Not Found", { status: 404 });
  };

  socket = (path: string): DeskSocket => {
    const s = new Socket();
    if (path === "/api/desk/events") this.events = s;
    return s;
  };
}

let hub: FakeHub;
let disconnect: () => void;

const grids = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

const connect = async () => {
  disconnect = useDesk.getState().connect(hub);
  await act(async () => {
    await Promise.resolve();
    hub.events!.say({ type: "snapshot", sessions: [sessionOf()], restore: [], rooms: [], layout: hub.layout } as DeskEvent);
  });
  await waitFor(() => expect(useHubLayout.getState().layout).not.toBeNull());
  await waitFor(() => expect(useDesk.getState().sessions.s1).toBeTruthy());
};

beforeEach(() => {
  hub = new FakeHub();
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null });
  startGrids(grids(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  useTerminals.setState({ byId: {}, known: true, programs: {}, problems: {} });
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }], roster: [] });
  useSettings.setState({ loaded: true, layoutOnHub: true, groups: [], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
  useOverview.setState({ manager: null, managerSupport: "unknown", overviewSupport: "no", suggestions: {}, suggestionsLoaded: true });
});
afterEach(() => {
  disconnect?.();
  cleanup();
});

const memoryTab = async () => {
  render(<SessionCard session={useDesk.getState().sessions.s1!} />);
  fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
};

describe("Desk Memory, against the hub", () => {
  it("asks once for Acme, notes, takes a confirm and a correction, stops remembering, and forgets", async () => {
    await connect();
    await memoryTab();
    expect(hub.requests).toContain("POST /api/desk/sessions/s1/memory/derive");
    // The session's own view stays mounted beside the Memory tab.
    expect(screen.getByRole("tab", { name: "Session" }).getAttribute("aria-selected")).toBe("false");
    const own = document.querySelector<HTMLElement>(".session-view")!;
    expect(own.hidden).toBe(true);
    expect(own.querySelector(".terminal-idle")).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Memory" }).getAttribute("aria-controls")).toBe(screen.getByRole("tabpanel").id);

    // Asked once: the answer goes to Acme's switches, and notes come.
    const ask = screen.getByRole("group", { name: "Let Desk's model read Acme's sessions?" });
    await act(async () => fireEvent.click(within(ask).getByRole("button", { name: "Let it read them" })));
    expect(hub.settings.groups[0]).toMatchObject({ derive: true, deriveDecided: true });
    // Let, the session's notes are due again at once (the hub dropped what
    // was due while Acme's were off), and come into the same panel.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Decisions (1)" })).toBeTruthy());
    expect(hub.derives).toBe(2);
    expect(screen.queryByRole("group", { name: /Let Desk's model read/ })).toBeNull();

    await act(async () => fireEvent.click(within(screen.getByText(/secure cookie/).closest("li")!).getByRole("button", { name: "Confirm" })));
    await waitFor(() => expect(within(screen.getByText(/secure cookie/).closest("li")!).getByText("confirmed")).toBeTruthy());

    fireEvent.click(within(screen.getByText("Sessions live in Redis.").closest("li")!).getByRole("button", { name: "Correct" }));
    const box = screen.getByRole("textbox", { name: "What the note should say" });
    fireEvent.change(box, { target: { value: "Sessions live in Postgres." } });
    await act(async () => fireEvent.submit(box.closest("form")!));
    await waitFor(() => expect(screen.getByText(/Sessions live in Postgres\./)).toBeTruthy());
    expect(screen.getByText("Sessions live in Redis.").tagName).toBe("S");
    expect(screen.getByText(/^\(replaced /)).toBeTruthy();

    // Remembering off for this session.
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Remember" })));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Remember" }).getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("Remembering is off for this session.")).toBeTruthy();
    expect(hub.memoryOn).toBe(false);

    // Forgotten.
    fireEvent.click(screen.getByRole("button", { name: "Forget…" }));
    const dialog = screen.getByRole("dialog", { name: "Forget what Desk remembers of “atlas-api”?" });
    // The two held, and the one the correction replaced.
    expect(dialog.textContent).toContain("This removes its 48 exchanges and 3 notes, and its summary, from Desk.");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Forget" })));
    await waitFor(() => expect(screen.getByText("You asked Desk to forget this conversation.")).toBeTruthy());
    expect(hub.requests).toContain("DELETE /api/desk/sessions/s1/memory");
    expect(screen.getByText("Remembered: 0 exchanges")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Decisions/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Forget…" })).toBeNull();
  });

  it("sets Acme's memory from its menu in the sidebar", async () => {
    await connect();
    render(<SidebarGroups />);
    fireEvent.click(screen.getByRole("button", { name: "Acme options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Memory…" }));
    const dialog = await screen.findByRole("dialog", { name: "Memory for Acme" });
    await waitFor(() => expect(within(dialog).getAllByRole("switch")).toHaveLength(2));
    await act(async () => fireEvent.click(within(dialog).getByRole("switch", { name: "Remember its sessions" })));
    expect(hub.requests).toContain("PATCH /api/desk/memory/groups/g-acme");
    expect(hub.settings.groups[0]!.harvest).toBe(false);
    await waitFor(() => expect(within(dialog).getByRole("switch", { name: "Remember its sessions" }).getAttribute("aria-checked")).toBe("false"));
  });

  it("pauses remembering in Settings, the open panel hears it and says so, and resumes it", async () => {
    await connect();
    await memoryTab();
    const settings = render(<Memory />);
    const pause = await within(settings.container).findByRole("switch", { name: "Pause remembering" });
    await act(async () => fireEvent.click(pause));
    expect(hub.settings.paused).toBe(true);
    // The panel, open all along, is told.
    await waitFor(() => expect(screen.getByText("Remembering is paused for every session.")).toBeTruthy());
    settings.unmount();
    expect(screen.getByText("Remembering is paused for every session.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resume remembering" })));
    expect(hub.settings.paused).toBe(false);
    await waitFor(() => expect(screen.queryByText("Remembering is paused for every session.")).toBeNull());
  });
});
