// Rooms, boards and the Floor in a grid's panes: each the real view, under a
// header that says what it is; several at once in one grid; read as the room
// view reads; and a narrow or short pane laid out for its size.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomMessage, Session } from "../hub/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()), emit: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("../session/Terminal", () => ({ Terminal: () => null }));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../rooms/engine", async (real) => ({ ...(await real<object>()), say: vi.fn(async () => {}) }));
// The Floor's reads go to the hub every minute: here the stores are set.
vi.mock("../floor/Floor", async (real) => ({ ...(await real<object>()), useFloorReads: () => {} }));

const { useDesk } = await import("../hub/store");
const { emitTo } = await import("@tauri-apps/api/event");
const { useChat } = await import("../chat/store");
const { useUi } = await import("../shell/ui");
const { useBoard } = await import("../board/store");
const { useFloor } = await import("../floor/store");
const { useOverview } = await import("../overview/store");
const { useSettings } = await import("../settings/store");
const { useHubLayout } = await import("../groups/hubLayout");
const { useReads } = await import("../unread/reads");
const { useUnread } = await import("../unread/summary");
const { useWatching } = await import("../unread/watching");
const { SEEN_MS } = await import("../unread/seen");
const { GridCanvas } = await import("./GridView");
const { MAIN_GRID } = await import("./model");
const { layOut, startGrids, toggleFill, useGrids } = await import("./store");
const { Board, columnDroppedOn } = await import("../board/BoardView");
const { TicketPopup } = await import("../board/TicketDetail");
const { landing, columns } = await import("../board/board");
const { NARROW_PANE, SHORT_PANE } = await import("./kinds");
const { ACME, ticket } = await import("../board/testing");
const { agent, hub, need, ready, session: who, view, work } = await import("../floor/testing");
const { say } = await import("../rooms/engine");
type GridStorage = import("./storage").GridStorage;
type PaneContent = import("./engine").PaneContent;

// jsdom lays nothing out.
Element.prototype.scrollIntoView = () => {};

/** An IntersectionObserver the test drives: `showAll` puts everything
 *  observed on screen. */
class FakeObserver {
  static all: FakeObserver[] = [];
  observed: Element[] = [];
  constructor(private cb: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.observed = [];
  }
  show(ratio: number) {
    for (const el of this.observed)
      this.cb([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
const showAll = () => act(() => FakeObserver.all.forEach((o) => o.show(1)));

const memory = (): GridStorage => {
  const kept = new Map<string, unknown>();
  return { get: (k) => kept.get(k), set: (k, v) => void kept.set(k, structuredClone(v)), remove: (k) => void kept.delete(k), subscribe: () => () => {} } as GridStorage;
};

const at = (s: number) => new Date(Date.UTC(2026, 10, 11, 9, 0, s)).toISOString();
const msg = (id: string, s: number, over: Partial<RoomMessage> = {}): RoomMessage => ({
  id,
  roomId: "r1",
  threadId: null,
  author: "local/allan",
  content: `said ${id}`,
  hop: 0,
  createdAt: at(s),
  ...over,
});
const engineering = {
  id: "r1",
  slug: "engineering",
  name: "Engineering",
  channel: "desk:r1",
  members: [
    { hub: "local", agent: "allan" },
    { hub: "local", agent: "lattice" },
  ],
  defaultMember: null,
  createdAt: "",
  updatedAt: "",
};
const DOCS = { ...ACME, id: "b-docs", name: "Docs site", prefix: "DOC" };

const page = vi.fn(async () => {});
const reloadRoom = vi.fn(async () => {});
let puts: { place: string; point: { at: string; message: string | null } }[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  FakeObserver.all = [];
  puts = [];
  page.mockClear();
  reloadRoom.mockClear();
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.spyOn(document, "hasFocus").mockImplementation(() => true);
  useGrids.setState({ ready: false, role: { kind: "main" }, order: [], grids: {}, active: MAIN_GRID, focus: {}, open: {}, undo: {}, flash: null, filled: {} });
  startGrids(memory(), { kind: "main" }, { deliver: vi.fn(), rename: vi.fn() });
  useChat.setState({
    hubs: [hub("local")],
    roster: [
      { hubId: "local", id: "allan", name: "Allan", model: null, provider: null, isDefault: false },
      { hubId: "local", id: "lattice", name: "Lattice", model: null, provider: null, isDefault: false },
    ],
  });
  useUi.setState({ roomThreads: {}, anchors: {}, flash: null });
  useDesk.setState({
    view: "grids",
    loaded: true,
    connected: true,
    sessions: {
      "s-web": { id: "s-web", name: "acme-web", engine: "claude", state: "working", live: true, origin: "desk", cwd: "/w", createdAt: at(0), updatedAt: at(1) } as Session,
      "s-api": { id: "s-api", name: "acme-api", engine: "claude", state: "working", live: true, origin: "desk", cwd: "/w", createdAt: at(0), updatedAt: at(1) } as Session,
    },
    rooms: { r1: engineering },
    timelines: { r1: [msg("a", 1), msg("b", 2, { author: "local/lattice", replyCount: 2, lastReplyAt: at(5) })] },
    windows: {},
    paging: {},
    roomDrafts: {},
    page,
    reloadRoom,
    hub: { putReads: vi.fn(async (p: typeof puts) => (puts.push(...p), p.map((x) => ({ place: x.place, ...x.point })))) } as never,
  });
  useReads.setState({ local: { "room:r1": { at: at(1), message: "a" } }, dms: {}, loaded: true });
  useUnread.setState({
    local: {
      floor: at(0),
      rooms: [{ roomId: "r1", main: { count: 1, forYou: 1, first: "b", lastAt: at(2) }, threads: [] }],
      sessions: [],
      activity: { count: 0, lastAt: null },
      brief: null,
      update: null,
    },
  });
  useWatching.setState({ on: {}, held: {} });
  useBoard.setState({
    supported: true,
    boards: { [ACME.id]: ACME, [DOCS.id]: DOCS },
    tickets: Object.fromEntries(
      [
        ticket(1, { state: "todo" }),
        ticket(2, { state: "todo" }),
        ticket(3, { state: "doing", assignee: { kind: "session", id: "s-web", name: "acme-web" } }),
        ticket(4, { state: "review", pinned: true }),
        ticket(5, { state: "done", stateAt: new Date().toISOString() }),
        ticket(6, { board: DOCS.id, key: "DOC-6", state: "todo" }),
      ].map((t) => [t.id, t]),
    ),
    open: null,
    popup: null,
  });
  // Platform holds acme-web and Allan; acme-api and Lattice are in no group.
  useSettings.setState({
    groups: [{ id: "g-platform", name: "Platform", collapsed: false, items: ["session:s-web", "agent:local/allan"] }],
    ungrouped: { collapsed: false, items: [] },
  });
  useFloor.setState({
    hubs: {
      local: ready(
        view({
          needs: [need("q1", who("s-web", "acme-web"), { ask: "Run the staging migration?", group: "g-platform" }), need("q2", who("s-api", "acme-api"), { ask: "Which branch?" })],
          working: [work(agent("allan", "Allan"), { group: "g-platform" }), work(who("s-api", "acme-api"))],
          counts: { working: 2, needsYou: 2, doneToday: 0 },
        }),
      ),
    },
    day: 0,
  });
  useOverview.setState({ overview: { brief: null, counts: { working: 2, needsYou: 2, doneToday: 0 }, items: [] }, manager: null, activitySupport: "no" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const room: PaneContent = { kind: "room", room: "r1" };
const acme: PaneContent = { kind: "board", board: ACME.id };
const docs: PaneContent = { kind: "board", board: DOCS.id };
const floor: PaneContent = { kind: "floor" };
const platform: PaneContent = { kind: "floor", group: "g-platform" };

/** The main grid laid out as `preset`, holding `contents` in order. */
const grid = (preset: Parameters<typeof layOut>[1], ...contents: PaneContent[]) => {
  contents.forEach((content, slot) => layOut(MAIN_GRID, preset, { slot, content }));
  return render(<Canvas />);
};
function Canvas() {
  const g = useGrids((s) => s.grids[MAIN_GRID]!);
  return <GridCanvas grid={g} />;
}
const pane = (name: string) => screen.getByRole("region", { name });

describe("a room in a pane", () => {
  it("is the room's timeline and composer, under a header saying it's a room and who is in it", () => {
    grid("halves", room);
    const p = pane("Engineering");
    expect(within(p).getByText("Room · Allan, Lattice, you")).toBeTruthy();
    expect(within(p).getByText("said a")).toBeTruthy();
    // No second header: the pane's says what it is.
    expect(within(p).queryByRole("heading", { name: "Engineering" })).toBeNull();
    const box = within(p).getByRole("combobox");
    expect(box.getAttribute("placeholder")).toMatch(/^Message Engineering/);
    fireEvent.change(box, { target: { value: "Ship it" } });
    fireEvent.submit(box.closest("form")!);
    expect(say).toHaveBeenCalledWith(engineering, "Ship it", null, [], { alsoInRoom: false });
  });

  it("reads the room's newest messages when nothing has yet, and again when the hub is back", () => {
    grid("halves", room);
    expect(page).toHaveBeenCalledWith("r1", null, "newest");
    act(() => useDesk.setState({ connected: false, windows: { r1: { older: { kind: "start" }, newer: { kind: "end" } } } }));
    act(() => useDesk.setState({ connected: true }));
    expect(reloadRoom).toHaveBeenCalledWith("r1");
  });

  it("is read while it's on screen, as the room view is, and not while another pane fills the grid", () => {
    grid("halves", room, floor);
    const roomPane = useGrids.getState().grids[MAIN_GRID]!.panes.find((p) => p.content?.kind === "room")!;
    const floorPane = useGrids.getState().grids[MAIN_GRID]!.panes.find((p) => p.content?.kind === "floor")!;
    // The Floor fills the grid: the room is out of sight.
    act(() => toggleFill(MAIN_GRID, floorPane.id));
    showAll();
    act(() => void vi.advanceTimersByTime(SEEN_MS * 2));
    expect(puts.filter((p) => p.place === "room:r1")).toEqual([]);
    expect(useWatching.getState().on["room:r1"]).toBeUndefined();
    // Back in the grid, on screen: read through its newest.
    act(() => toggleFill(MAIN_GRID, floorPane.id));
    showAll();
    act(() => void vi.advanceTimersByTime(SEEN_MS * 2));
    expect(useWatching.getState().on["room:r1"]).toBe(1);
    expect(puts.filter((p) => p.place === "room:r1").at(-1)?.point).toEqual({ at: at(2), message: "b" });
    expect(roomPane.id).toBeTruthy();
  });

  it("opens a thread in Rooms, where threads show", () => {
    grid("halves", room);
    fireEvent.click(within(pane("Engineering")).getByRole("button", { name: /2 replies/ }));
    expect(useDesk.getState().view).toBe("rooms");
    expect(useDesk.getState().activeRoom).toBe("r1");
  });

  it("says so when the room has gone, and closing it says nothing is lost", () => {
    grid("halves", { kind: "room", room: "gone" });
    const p = pane("Room");
    expect(within(p).getByText("This room is no longer on this computer.")).toBeTruthy();
    fireEvent.click(within(p).getByRole("button", { name: "Remove from grid" }));
    expect(screen.getByRole("dialog").textContent).toMatch(/no longer there, so nothing is lost/);
  });
});

describe("a board in a pane", () => {
  it("is the board's columns, with its filter in the pane's header", () => {
    grid("halves", acme);
    const p = pane("Acme");
    expect(within(p).getByText("ACM · 5 tickets")).toBeTruthy();
    expect(within(p).getByText("Ticket 1")).toBeTruthy();
    expect(within(p).getByText("Ticket 4")).toBeTruthy();
    // Another board's tickets aren't here.
    expect(within(p).queryByText("Ticket 6")).toBeNull();
    const show = within(p).getByRole("group", { name: "Show" });
    fireEvent.click(within(show).getByRole("button", { name: "Pinned" }));
    expect(within(show).getByRole("button", { name: "Pinned" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(p).queryByText("Ticket 1")).toBeNull();
    expect(within(p).getByText("Ticket 4")).toBeTruthy();
  });

  it("has a tab for each column, with its count, for when the pane is narrow; a card dropped on a tab goes to that column's end", () => {
    grid("halves", acme);
    const tabs = within(pane("Acme")).getByRole("tablist", { name: "Column" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Backlog", "To do 2", "Doing 1", "Review 1", "Done 1"]);
    // What's being done is shown until another column is picked.
    expect(within(tabs).getByRole("tab", { name: "Doing 1" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(tabs).getByRole("tab", { name: "Review 1" }));
    expect(within(tabs).getByRole("tab", { name: "Review 1" }).getAttribute("aria-selected")).toBe("true");
    const review = document.getElementById(within(tabs).getByRole("tab", { name: "Review 1" }).getAttribute("aria-controls")!)!;
    expect(review.className).toMatch(/board-col-on/);
    // Dropped on Doing's tab: the end of Doing (t3, its last card, before it).
    expect(columnDroppedOn("tab:doing")).toBe("doing");
    expect(columnDroppedOn("col:review")).toBe("review");
    expect(columnDroppedOn("t3")).toBeNull();
    const cols = columns(Object.values(useBoard.getState().tickets).filter((t) => t.board === ACME.id), { filter: "all", q: "", now: Date.now(), waiting: () => false });
    expect(landing(cols, "t1", { column: columnDroppedOn("tab:doing")! })).toEqual({ state: "doing", before: "t3" });
  });

  it("counts its columns and what waits on you, for when the pane is short", () => {
    grid("halves", acme);
    const counts = within(pane("Acme")).getByRole("list", { name: "Counts" });
    expect(within(counts).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["To do2", "Doing1", "Review1", "Waiting on me2"]);
  });

  it("opens a ticket as a popup over the grid; a grid's own window has it opened in the main window", () => {
    grid("halves", acme);
    fireEvent.click(within(pane("Acme")).getByText("Ticket 4"));
    expect(useBoard.getState().popup).toBe("t4");
    expect(useBoard.getState().open).toBeNull();
    act(() => useBoard.setState({ popup: null }));
    useDesk.setState({ detached: true });
    fireEvent.click(within(pane("Acme")).getByText("Ticket 4"));
    expect(useBoard.getState().popup).toBeNull();
    expect(vi.mocked(emitTo)).toHaveBeenCalledWith("main", "desk-open", { kind: "ticket", id: "t4" });
    useDesk.setState({ detached: false });
  });
});

describe("the Floor in a pane", () => {
  it("is the Floor's main column, with its counts in the pane's header", () => {
    grid("halves", floor);
    const p = pane("Floor");
    expect(within(p).getByRole("region", { name: "Right now" })).toBeTruthy();
    expect(within(p).getByText("Run the staging migration?")).toBeTruthy();
    expect(within(p).getByText("Which branch?")).toBeTruthy();
    expect(within(p).getByRole("region", { name: "Today" })).toBeTruthy();
    expect(p.querySelector(".gpane-head .gpane-meta")?.textContent).toBe("2 working · 2 need you · 0 done today");
  });

  it("of one group, shows that group's alone, in its header and its short counts too", () => {
    grid("halves", platform);
    const p = pane("Floor ›\u00a0Platform");
    expect(within(p).getByText("Run the staging migration?")).toBeTruthy();
    expect(within(p).queryByText("Which branch?")).toBeNull();
    expect(p.querySelector(".gpane-head .gpane-meta")?.textContent).toBe("1 working · 1 needs you · 0 done today");
    const counts = within(p).getByRole("list", { name: "Counts" });
    expect(within(counts).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1 working", "1 needs you", "0 done"]);
  });

  it("of a group since removed says so, once the sidebar's groups are known for sure", () => {
    useSettings.setState({ loaded: false });
    useHubLayout.setState({ layout: null, kept: null });
    grid("halves", { kind: "floor", group: "g-gone" });
    // Not known yet: no "removed group" for a moment.
    expect(within(pane("Floor")).getByText("Reading the Floor…")).toBeTruthy();
    act(() => {
      useSettings.setState({ loaded: true });
      useHubLayout.setState({ kept: false });
    });
    expect(within(pane("Floor ›\u00a0a removed group")).getByText(/no longer in the sidebar/)).toBeTruthy();
  });
});

describe("several at once in one grid", () => {
  it("two boards, a room, the Floor and a group's Floor: each works, and no two elements share an id", () => {
    const { container } = grid("nine", acme, docs, room, floor, platform);
    expect(within(pane("Acme")).getByText("Ticket 1")).toBeTruthy();
    expect(within(pane("Docs site")).getByText("Ticket 6")).toBeTruthy();
    expect(within(pane("Floor")).getByText("Which branch?")).toBeTruthy();
    expect(within(pane("Floor ›\u00a0Platform")).queryByText("Which branch?")).toBeNull();
    // Each board keeps its own filter.
    fireEvent.click(within(within(pane("Acme")).getByRole("group", { name: "Show" })).getByRole("button", { name: "Pinned" }));
    expect(within(pane("Docs site")).getByText("Ticket 6")).toBeTruthy();
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    for (const el of container.querySelectorAll("[aria-labelledby], [aria-controls]")) {
      for (const ref of `${el.getAttribute("aria-labelledby") ?? ""} ${el.getAttribute("aria-controls") ?? ""}`.split(" ").filter(Boolean))
        expect(container.querySelector(`#${CSS.escape(ref)}`)).not.toBeNull();
    }
  });
});

describe("a pane a newer Desk put in the grid", () => {
  it("says to update Desk, and keeps what it holds", () => {
    const newer = { kind: "chart", chart: "c1" } as unknown as PaneContent;
    grid("halves", newer);
    expect(within(pane("Pane from a newer Desk")).getByText("A newer Desk put this here. Update Desk to show it.")).toBeTruthy();
    expect(useGrids.getState().grids[MAIN_GRID]!.panes.some((p) => p.content === newer || JSON.stringify(p.content) === JSON.stringify(newer))).toBe(true);
  });
});

// The stylesheet as written (Vitest hands CSS imports over empty).
const fs = (await import("node:fs" as string)) as { readFileSync: (path: string, enc: "utf8") => string };
const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const css = fs.readFileSync(`${cwd}/src/styles/grids.css`, "utf8");

describe("narrow and short panes, in grids.css", () => {
  const block = (query: string): string => {
    const all = [...css.matchAll(new RegExp(`@container gpane \\(${query}\\) \\{([\\s\\S]*?)\\n\\}`, "g"))].map((m) => m[1]);
    return all.join("\n");
  };

  it("a narrow board shows its tabs and the picked column alone; the Floor's plan meters fold to a line", () => {
    const narrow = block(`max-width: ${NARROW_PANE}px`);
    expect(narrow).toMatch(/\.board-in-pane \.board-tabs \{\s*display: flex;/);
    expect(narrow).toMatch(/\.board-in-pane \.board-col:not\(\.board-col-on\) \{\s*display: none;/);
    expect(narrow).toMatch(/\.floor-in-pane \.plan-window \{\s*flex-direction: row;/);
  });

  it("a short board shows its counts, a short Floor its", () => {
    const short = block(`max-height: ${SHORT_PANE}px`);
    expect(short).toMatch(/\.board-in-pane \.board-short \{\s*display: grid;/);
    expect(short).toMatch(/\.gpane-body \.floor-short \{\s*display: flex;/);
  });

  it("are measured on the pane's body, for rooms, boards and the Floor", () => {
    expect(css).toMatch(/\.gpane-k-room \.gpane-body,\s*\.gpane-k-board \.gpane-body,\s*\.gpane-k-floor \.gpane-body \{\s*container: gpane \/ size;/);
  });
});

describe("a synced board in a pane", () => {
  it("has the board's filters in its header (Everyone, Mine, Unassigned, Waiting on me, Pinned), and Take it on a card no one has", () => {
    const ext = (key: string, assignee: { id: string; name: string } | null) => ({ system: "jira" as const, key, url: `https://x.test/${key}`, remoteUpdatedAt: at(0), synced: true, link: "l1", assignee });
    useBoard.setState({
      boards: {
        [ACME.id]: {
          ...ACME,
          sync: { link: "l1", system: "jira", target: "SHOP", via: { kind: "thisHub" }, person: "me@x.test", filter: { kind: "project" }, states: {}, me: "u-me", meSource: "vouched" } as never,
        },
      },
      tickets: Object.fromEntries(
        [
          ticket(1, { state: "todo", title: "Mine there", external: ext("SHOP-1", { id: "u-me", name: "Me" }) }),
          ticket(2, { state: "todo", title: "No one's", external: ext("SHOP-2", null) }),
          ticket(3, { state: "doing", title: "Dana's", external: ext("SHOP-3", { id: "u-dana", name: "Dana Kim" }) }),
        ].map((t) => [t.id, t]),
      ),
    });
    grid("halves", acme);
    const p = pane("Acme");
    const show = within(p).getByRole("group", { name: "Show" });
    expect(within(show).getAllByRole("button").map((b) => b.textContent)).toEqual(["Everyone", "Mine", "Unassigned", "Waiting on me", "Pinned"]);
    expect(within(p).getAllByRole("button", { name: /^Take / }).map((b) => b.getAttribute("aria-label"))).toEqual(["Take ACM-2"]);
    fireEvent.click(within(show).getByRole("button", { name: "Mine" }));
    expect(within(p).getByText("Mine there")).toBeTruthy();
    expect(within(p).queryByText("No one's")).toBeNull();
    fireEvent.click(within(show).getByRole("button", { name: "Unassigned" }));
    expect(within(p).getByText("No one's")).toBeTruthy();
    expect(within(p).queryByText("Dana's")).toBeNull();
  });
});

describe("a board pane's filter", () => {
  it("goes when the pane shows another board, or closes", async () => {
    const { usePaneFilters } = await import("./kinds");
    const { replacePane, closePane } = await import("./store");
    grid("halves", acme);
    const id = useGrids.getState().grids[MAIN_GRID]!.panes.find((p) => p.content?.kind === "board")!.id;
    fireEvent.click(within(within(pane("Acme")).getByRole("group", { name: "Show" })).getByRole("button", { name: "Pinned" }));
    expect(usePaneFilters.getState()[`${MAIN_GRID}/${id}`]).toBe("pinned");
    act(() => replacePane(MAIN_GRID, id, docs));
    expect(usePaneFilters.getState()[`${MAIN_GRID}/${id}`]).toBeUndefined();
    expect(within(within(pane("Docs site")).getByRole("group", { name: "Show" })).getByRole("button", { name: "Everyone" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(within(pane("Docs site")).getByRole("group", { name: "Show" })).getByRole("button", { name: "Pinned" }));
    act(() => closePane(MAIN_GRID, id));
    expect(usePaneFilters.getState()[`${MAIN_GRID}/${id}`]).toBeUndefined();
  });
});

describe("a board pane's column tabs", () => {
  it("are there only while the pane is narrow, so hidden tabs take no drops", () => {
    let width = 800;
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: () => void) {
          observers.push(() => this.cb());
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width, height: 400, top: 0, left: 0, right: width, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
    grid("halves", acme);
    expect(within(pane("Acme")).queryByRole("tablist", { name: "Column" })).toBeNull();
    width = NARROW_PANE - 1;
    act(() => observers.forEach((o) => o()));
    expect(within(pane("Acme")).getByRole("tablist", { name: "Column" })).toBeTruthy();
  });
});

describe("a board pane's columns scroll sideways whenever they don't fit", () => {
  const boardCss = fs.readFileSync(`${cwd}/src/styles/board.css`, "utf8");
  const rule = (src: string, selector: string): string => {
    const at = src.indexOf(`${selector} {`);
    return at < 0 ? "" : src.slice(at, src.indexOf("}", at));
  };

  it("a sideways swipe over a column's cards goes on to the columns: its cards hold up and down only", () => {
    const cards = rule(boardCss, ".board-cards");
    expect(cards).toMatch(/overscroll-behavior-y: contain;/);
    expect(cards).not.toMatch(/overscroll-behavior: contain;/);
  });

  it("a pane's columns don't snap, so a small step isn't pulled back", () => {
    expect(rule(css, ".board-in-pane .board-cols")).toMatch(/scroll-snap-type: none;/);
  });

  it("their scrollbar is in sight, in the theme's colours", () => {
    expect(boardCss).toMatch(/\.board-cols::-webkit-scrollbar \{\s*height: 8px;/);
    expect(rule(boardCss, ".board-cols::-webkit-scrollbar-thumb")).toMatch(/var\(--faint\)/);
    expect(rule(boardCss, ".board-cols::-webkit-scrollbar-thumb:hover")).toMatch(/var\(--faint\)/);
    // scrollbar-color would override the rules above in Chromium.
    expect(boardCss).not.toMatch(/scrollbar-color/);
  });

  it("Shift+wheel left vertical scrolls them sideways; one the system already turned sideways is left to it", () => {
    grid("halves", acme);
    const cols = pane("Acme").querySelector<HTMLElement>(".board-cols")!;
    Object.defineProperty(cols, "scrollWidth", { configurable: true, value: 1500 });
    Object.defineProperty(cols, "clientWidth", { configurable: true, value: 600 });
    const by: number[] = [];
    cols.scrollBy = ((o: ScrollToOptions) => by.push(o.left ?? 0)) as typeof cols.scrollBy;
    const shifted = new WheelEvent("wheel", { deltaY: 120, shiftKey: true, bubbles: true, cancelable: true });
    cols.dispatchEvent(shifted);
    expect(by).toEqual([120]);
    expect(shifted.defaultPrevented).toBe(true);
    const turned = new WheelEvent("wheel", { deltaX: 120, shiftKey: true, bubbles: true, cancelable: true });
    cols.dispatchEvent(turned);
    const plain = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    cols.dispatchEvent(plain);
    expect(by).toEqual([120]);
    expect(turned.defaultPrevented || plain.defaultPrevented).toBe(false);
    // Columns that snap (the Board view's) are left to the browser.
    cols.style.scrollSnapType = "x mandatory";
    const snapping = new WheelEvent("wheel", { deltaY: 120, shiftKey: true, bubbles: true, cancelable: true });
    cols.dispatchEvent(snapping);
    expect(by).toEqual([120]);
    expect(snapping.defaultPrevented).toBe(false);
  });
});

describe("a ticket opened from a board pane", () => {
  beforeEach(() => {
    // The same hub, which a ticket's view also reads (a new one would read
    // the board again).
    Object.assign(useDesk.getState().hub!, {
      ticketHistory: vi.fn(async () => ({ events: [], more: false })),
      ledger: vi.fn(async () => ({ rows: [], next: null })),
      searchTickets: vi.fn(async () => []),
    });
  });
  const withPopup = () => {
    layOut(MAIN_GRID, "halves", { slot: 0, content: acme });
    return render(
      <>
        <Canvas />
        <TicketPopup />
      </>,
    );
  };
  const card = (key: string) => within(pane("Acme")).getByText(key).closest("button")!;
  const dialog = () => screen.queryByRole("dialog", { name: /^Ticket / });

  it("opens as a popup over the grid, not in the side panel", () => {
    withPopup();
    fireEvent.click(card("ACM-1"));
    expect(dialog()).toBeTruthy();
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
    expect(dialog()!.getAttribute("aria-label")).toBe("Ticket ACM-1");
    expect(useBoard.getState().popup).toBe("t1");
    expect(useBoard.getState().open).toBeNull();
    // The same ticket view as the side panel's.
    expect(within(dialog()!).getByRole("button", { name: "Ticket 1" })).toBeTruthy();
    expect(within(dialog()!).getByRole("combobox", { name: "State" })).toBeTruthy();
  });

  it("closes on Esc, and focus goes back to its card (opened by a click, which focuses nothing in WebKit)", () => {
    withPopup();
    const c = card("ACM-1");
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(c);
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(useBoard.getState().popup).toBeNull();
    expect(document.activeElement).toBe(card("ACM-1"));
  });

  it("closes on a click outside it, not on one inside", () => {
    withPopup();
    fireEvent.click(card("ACM-2"));
    fireEvent.mouseDown(within(dialog()!).getByRole("button", { name: "Ticket 2" }));
    expect(dialog()).toBeTruthy();
    fireEvent.mouseDown(dialog()!.parentElement!);
    expect(dialog()).toBeNull();
  });

  it("keeps Tab inside it", () => {
    withPopup();
    fireEvent.click(card("ACM-1"));
    const inside = [...dialog()!.querySelectorAll<HTMLElement>("button:not([disabled]), select, input, textarea")];
    inside.at(-1)!.focus();
    fireEvent.keyDown(inside.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(inside[0]);
    fireEvent.keyDown(inside[0]!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(inside.at(-1));
  });

  it("goes back to its card when that card was redrawn meanwhile", () => {
    withPopup();
    const c = card("ACM-1");
    c.focus();
    fireEvent.click(c);
    // Moved to Review elsewhere: its card is drawn again in another column.
    act(() => useBoard.getState().heard({ ...useBoard.getState().tickets.t1!, state: "review" }));
    expect(c.isConnected).toBe(false);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(card("ACM-1"));
  });

  it("Open in side panel moves it to the side panel", () => {
    withPopup();
    fireEvent.click(card("ACM-1"));
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Open in side panel" }));
    expect(dialog()).toBeNull();
    expect(useBoard.getState().popup).toBeNull();
    expect(useBoard.getState().open).toBe("t1");
  });

  it("a ticket it needs opens in the popup too", () => {
    act(() => useBoard.getState().heard({ ...useBoard.getState().tickets.t1!, needs: ["t2"] }));
    withPopup();
    fireEvent.click(card("ACM-1"));
    fireEvent.click(dialog()!.querySelector<HTMLElement>(".ticket-need-open")!);
    expect(useBoard.getState().popup).toBe("t2");
    expect(useBoard.getState().open).toBeNull();
    expect(dialog()!.getAttribute("aria-label")).toBe("Ticket ACM-2");
  });

  it("Esc in its Snooze menu closes the menu, not the popup", () => {
    withPopup();
    fireEvent.click(card("ACM-1"));
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Snooze" }));
    const menu = screen.getByRole("menu", { name: "Snooze" });
    fireEvent.keyDown(within(menu).getAllByRole("menuitem")[0]!, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Snooze" })).toBeNull();
    expect(dialog()).toBeTruthy();
  });

  it("Esc in its Delete confirmation closes only that", () => {
    withPopup();
    fireEvent.click(card("ACM-1"));
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Delete ticket…" }));
    const confirm = screen.getByRole("dialog", { name: "Delete ACM-1?" });
    fireEvent.keyDown(document.activeElement ?? confirm, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Delete ACM-1?" })).toBeNull();
    expect(dialog()).toBeTruthy();
  });

  it("after a need opened in it, focus is still in it, so Esc still closes it", () => {
    act(() => useBoard.getState().heard({ ...useBoard.getState().tickets.t1!, needs: ["t2"] }));
    withPopup();
    fireEvent.click(card("ACM-1"));
    const need = dialog()!.querySelector<HTMLElement>(".ticket-need-open")!;
    need.focus();
    fireEvent.click(need);
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(dialog()).toBeNull();
  });

  it("a ticket that can't be read closes it rather than reading forever", () => {
    withPopup();
    useDesk.setState({ hub: null });
    act(() => useBoard.getState().openPopup("t-unknown"));
    expect(dialog()).toBeNull();
    expect(useBoard.getState().popup).toBeNull();
  });

  it("the Board view itself still opens it in the side panel", () => {
    useBoard.setState({ shown: ACME.id });
    render(<Board />);
    fireEvent.click(screen.getByText("ACM-1").closest("button")!);
    expect(useBoard.getState().open).toBe("t1");
    expect(useBoard.getState().popup).toBeNull();
  });
});
