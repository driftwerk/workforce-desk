// Moving a session between groups, end to end against a fake hub: Desk's own
// client over a transport that keeps the sidebar's groups and its bosses (as
// bosses.e2e.test.tsx does), and the hub's move routes over `fetch` as the
// person who holds the hub reaches them with the paired token. acme-docs sits
// in Acme, which Sarah oversees; moving it to Globex, Mia's, is previewed and
// asked about, nothing moves until Move, and the note goes as edited. A move
// within the main boss's part goes as before, and a token that isn't the
// holder's moves nothing.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { setDevToken } from "../hub/devTokens";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import type { DeskEvent, Manager, Session } from "../hub/types";
import { useOverview } from "../overview/store";
import { useSettings } from "../settings/store";
import { useHubLayout } from "./hubLayout";
import { EMPTY_LAYOUT, type Layout } from "./model";
import { useMove } from "./move";
import { MoveDialog } from "./MoveDialog";
import { SidebarGroups } from "./SidebarGroups";
import { draftNote, movesHub, oversightHub, type MoveAnswer } from "./testing";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

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

const session = (id: string, name: string): Session =>
  ({
    id,
    name,
    engine: "claude",
    goal: "",
    cwd: "/work",
    state: "idle",
    live: true,
    origin: "desk",
    pending: null,
    updatedAt: "2026-11-08T10:00:00Z",
    createdAt: "2026-11-08T09:00:00Z",
  }) as Session;

/** The hub's side of the sidebar: its groups, their bosses and sessions. */
class FakeHub implements DeskTransport {
  requests: string[] = [];
  events: Socket | null = null;
  layout: Layout = {
    groups: [
      { id: "acme", name: "Acme", collapsed: false, items: ["agent:local/sarah", "session:s1"] },
      { id: "globex", name: "Globex", collapsed: false, items: ["agent:local/mia"] },
      { id: "personal", name: "Personal", collapsed: false, items: [] },
    ],
    ungrouped: { collapsed: false, items: ["agent:local/desk", "session:s2"] },
  };
  kept = oversightHub({
    desk: `[oversight]\nenabled = true\nlevel = "act"\n`,
    sarah: `[oversight]\nenabled = true\ngroup = "acme"\nlevel = "act"\n`,
    mia: `[oversight]\nenabled = true\ngroup = "globex"\nlevel = "act"\n`,
  });
  manager = (): Manager => this.kept.manager(this.layout.groups.map((g) => g.id));

  /** Puts `item` in group `to` (at its end), as the hub's layout does. */
  put(item: string, to: string) {
    const out = (items: string[]) => items.filter((i) => i !== item);
    this.layout = {
      groups: this.layout.groups.map((g) => ({ ...g, items: g.id === to ? [...out(g.items), item] : out(g.items) })),
      ungrouped: { ...this.layout.ungrouped, items: to === "ungrouped" ? [...out(this.layout.ungrouped.items), item] : out(this.layout.ungrouped.items) },
    };
    this.events?.say({ type: "layout", layout: this.layout } as DeskEvent);
  }

  fetch = async (method: string, path: string): Promise<Response> => {
    const route = `${method} ${path}`;
    this.requests.push(route);
    if (route === "GET /api/desk/manager") return json(this.manager());
    if (route === "GET /api/desk/sessions") return json([session("s1", "acme-docs"), session("s2", "notes")]);
    if (route === "GET /api/desk/layout") return json(this.layout);
    const put = /^\/api\/desk\/groups\/([^/]+)\/items\/(.+)$/.exec(path);
    if (put && method === "PUT") {
      this.put(decodeURIComponent(put[2]!), put[1]!);
      return json(this.layout);
    }
    return new Response("Not Found", { status: 404 });
  };

  socket = (path: string): DeskSocket => {
    const s = new Socket();
    if (path === "/api/desk/events") this.events = s;
    return s;
  };
}

/** Moving acme-docs out of Acme: to Globex crosses from Sarah to Mia; to
 *  Personal or Ungrouped, from Sarah to the main boss. Within the main
 *  boss's part nothing crosses. */
const answer: MoveAnswer = ({ item, to }) => {
  if (item.id === "s2") return { effects: [] };
  const boss = to === "globex" ? "mia" : "desk";
  const name = boss === "mia" ? "Mia" : "Desk";
  return {
    effects: [
      { kind: "charge_to", boss, text: `${name} runs acme-docs from now on.` },
      { kind: "handover", from: "sarah", to: boss, text: `${name} receives only the note below from Sarah.` },
      { kind: "tell", text: "acme-docs is told on its line that it moved." },
    ],
    handovers: [draftNote("session:s1", "sarah", boss, "Handing over acme-docs.")],
  };
};

let hub: FakeHub;
let moves: ReturnType<typeof movesHub>;
let disconnect: () => void;

const connect = async () => {
  disconnect = useDesk.getState().connect(hub);
  await act(async () => {
    await Promise.resolve();
    hub.events!.say({ type: "snapshot", sessions: [session("s1", "acme-docs"), session("s2", "notes")], restore: [], rooms: [], layout: hub.layout } as DeskEvent);
  });
  await waitFor(() => expect(useHubLayout.getState().layout).not.toBeNull());
  await waitFor(() => expect(useOverview.getState().manager?.bosses).toHaveLength(2));
};

const row = (name: string) => screen.getAllByRole("button").find((b) => b.dataset.item && b.querySelector(".gi-name")?.textContent === name)!;
const inGroup = (group: string) => within(screen.getByRole("group", { name: group }));
const moveFromMenu = (name: string, to: string) => {
  fireEvent.contextMenu(row(name));
  fireEvent.click(screen.getByRole("menuitem", { name: /Move to group/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: to }));
};
const layoutPuts = () => hub.requests.filter((r) => /^PUT \/api\/desk\/groups\/[^/]+\/items\//.test(r));

beforeEach(() => {
  hub = new FakeHub();
  moves = movesHub(answer);
  moves.made = (p) => hub.put(`session:${p.item.id}`, p.to ?? "ungrouped");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => (await moves.fetch(new URL(String(input)), init)) ?? new Response("Not Found", { status: 404 })),
  );
  setDevToken("local", "holder");
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://local.test", local: true, revision: "t" }],
    roster: [
      { hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: true },
      { hubId: "local", id: "sarah", name: "Sarah", model: null, provider: null, isDefault: false },
      { hubId: "local", id: "mia", name: "Mia", model: null, provider: null, isDefault: false },
    ],
  });
  useSettings.setState({ loaded: true, layoutOnHub: true, groups: [], ungrouped: EMPTY_LAYOUT.ungrouped, sessionNames: {} });
  useOverview.setState({ manager: null, managerSupport: "unknown", overviewSupport: "no", suggestions: {}, suggestionsLoaded: true });
  useMove.setState({ asking: null });
});
afterEach(() => {
  disconnect?.();
  cleanup();
  vi.unstubAllGlobals();
});

describe("moving a session between groups, against the hub", () => {
  it("asks first when it crosses to another boss, and moves with the note as edited, on Move only", async () => {
    await connect();
    render(
      <>
        <SidebarGroups />
        <MoveDialog />
      </>,
    );
    moveFromMenu("acme-docs", "Globex");
    const dialog = await screen.findByRole("dialog", { name: "Move acme-docs" });
    await within(dialog).findByText("Mia runs acme-docs from now on.");
    // Nothing has moved yet, and the old sidebar route is never taken.
    expect(inGroup("Acme").getByText("acme-docs")).toBeTruthy();
    expect(layoutPuts()).toEqual([]);
    expect(moves.asked).toEqual([{ item: { kind: "session", id: "s1" }, to: "globex", choices: { ticketGoes: true, release: false, replace: false } }]);

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Handover note" }), { target: { value: "For Mia: the guide's last section is left." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to Globex" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(moves.commits).toEqual([{ preview: "p1", choices: { ticketGoes: true, release: false, replace: false }, note: "For Mia: the guide's last section is left.", notes: [] }]);
    await waitFor(() => expect(inGroup("Globex").getByText("acme-docs")).toBeTruthy());
    expect(layoutPuts()).toEqual([]);
  });

  it("moves nothing when cancelled", async () => {
    await connect();
    render(
      <>
        <SidebarGroups />
        <MoveDialog />
      </>,
    );
    moveFromMenu("acme-docs", "Personal");
    const dialog = await screen.findByRole("dialog", { name: "Move acme-docs" });
    await within(dialog).findByText("Desk runs acme-docs from now on.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(moves.commits).toEqual([]);
    expect(layoutPuts()).toEqual([]);
    expect(inGroup("Acme").getByText("acme-docs")).toBeTruthy();
  });

  it("asks too when the keys take it over its group's edge", async () => {
    await connect();
    render(
      <>
        <SidebarGroups />
        <MoveDialog />
      </>,
    );
    fireEvent.keyDown(row("acme-docs"), { key: "ArrowDown", altKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Move acme-docs" });
    await within(dialog).findByText("Mia runs acme-docs from now on.");
    expect(layoutPuts()).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(inGroup("Acme").getByText("acme-docs")).toBeTruthy();
    expect(moves.commits).toEqual([]);
  });

  it("moves as before, unasked, within one boss's part", async () => {
    await connect();
    render(
      <>
        <SidebarGroups />
        <MoveDialog />
      </>,
    );
    moveFromMenu("notes", "Personal");
    await waitFor(() => expect(layoutPuts()).toEqual(["PUT /api/desk/groups/personal/items/session%3As2"]));
    expect(moves.asked).toEqual([{ item: { kind: "session", id: "s2" }, to: "personal", choices: { ticketGoes: true, release: false, replace: false } }]);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(inGroup("Personal").getByText("notes")).toBeTruthy());
  });

  it("moves nothing for a token that isn't the holder's, and says so", async () => {
    setDevToken("local", "gateway");
    await connect();
    render(
      <>
        <SidebarGroups />
        <MoveDialog />
      </>,
    );
    moveFromMenu("acme-docs", "Globex");
    const dialog = await screen.findByRole("dialog", { name: "Move acme-docs" });
    await within(dialog).findByText("Only the person who holds this computer’s hub can move things between groups.");
    expect((within(dialog).getByRole("button", { name: "Move to Globex" }) as HTMLButtonElement).disabled).toBe(true);
    expect(moves.asked).toEqual([]);
    expect(layoutPuts()).toEqual([]);
    expect(inGroup("Acme").getByText("acme-docs")).toBeTruthy();
  });
});
