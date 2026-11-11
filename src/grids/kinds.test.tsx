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
const { useChat } = await import("../chat/store");
const { useUi } = await import("../shell/ui");
const { useBoard } = await import("../board/store");
const { useFloor } = await import("../floor/store");
const { useOverview } = await import("../overview/store");
const { useSettings } = await import("../settings/store");
const { useReads } = await import("../unread/reads");
const { useUnread } = await import("../unread/summary");
const { useWatching } = await import("../unread/watching");
const { SEEN_MS } = await import("../unread/seen");
const { GridCanvas } = await import("./GridView");
const { MAIN_GRID } = await import("./model");
const { layOut, startGrids, toggleFill, useGrids } = await import("./store");
const { columnDroppedOn } = await import("../board/BoardView");
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
    expect(within(p).getByText("This room is no longer on this computer's hub.")).toBeTruthy();
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

  it("opens a ticket in its panel", () => {
    grid("halves", acme);
    fireEvent.click(within(pane("Acme")).getByText("Ticket 4"));
    expect(useBoard.getState().open).toBe("t4");
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

  it("of a group since removed says so", () => {
    grid("halves", { kind: "floor", group: "g-gone" });
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
