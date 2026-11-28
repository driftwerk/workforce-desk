// Making a plan of tickets already on a board: what can be taken on, what's
// handed over (at most PLAN_MAX), the message put in the boss's composer,
// and the board's picking, end to end as far as the boss's DM.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manager, Ticket } from "../hub/types";
import { ACME, API, ticket } from "./testing";
import { PLAN_MAX, adoptable, bossOfBoard, handover, pickedSaid, planAsk, whyNotAdoptable } from "./planFrom";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));

const { useChat } = await import("../chat/store");
const { emptyConversation } = await import("../chat/conversation");
const { useDesk } = await import("../hub/store");
const { useOverview } = await import("../overview/store");
const { useFocus } = await import("../shell/focus");
const { usePlans } = await import("../crew/planStore");
const { deskState } = await import("../restore/boot");
const { draftKey } = await import("../restore/drafts");
const { Board } = await import("./BoardView");
const { useBoard } = await import("./store");
const { Rooms } = await import("../rooms/Rooms");

Element.prototype.scrollIntoView = () => {};

const none = new Set<string>();
const many = (n: number): Ticket[] => Array.from({ length: n }, (_, i) => ticket(i + 1));

describe("what a plan can take on", () => {
  it("is a ticket not started yet and in no plan", () => {
    expect(adoptable(ticket(1), none)).toBe(true);
    expect(adoptable(ticket(1, { state: "todo" }), none)).toBe(true);
    expect(adoptable(ticket(1, { state: "doing" }), none)).toBe(false);
    expect(adoptable(ticket(1, { state: "review" }), none)).toBe(false);
    expect(adoptable(ticket(1, { state: "done" }), none)).toBe(false);
    expect(adoptable(ticket(1, { state: "todo", assignee: API }), none)).toBe(false);
    expect(adoptable(ticket(1), new Set(["t1"]))).toBe(false);
  });

  it("says why one can't be", () => {
    expect(whyNotAdoptable(ticket(4, { state: "doing" }), none)).toBe("ACM-4 is started already");
    expect(whyNotAdoptable(ticket(4), new Map([["t4", "p1"]]))).toBe("ACM-4 is in a plan already");
    expect(whyNotAdoptable(ticket(4, { state: "done" }), none)).toBe("ACM-4 is finished");
    expect(whyNotAdoptable(ticket(4), none)).toBeNull();
  });
});

describe("what's handed over", () => {
  it("leaves out what's started, and says so", () => {
    const h = handover([ticket(1), ticket(2, { state: "doing", assignee: API }), ticket(3, { state: "todo" })], none);
    expect(h.tickets.map((t) => t.key)).toEqual(["ACM-1", "ACM-3"]);
    expect(h).toMatchObject({ started: 1, over: 0 });
    expect(pickedSaid(h)).toEqual(["One picked ticket is started or in a plan already, and left out."]);
  });

  it(`is at most ${PLAN_MAX} tickets, with how many were left out said`, () => {
    const h = handover(many(34), none);
    expect(h.tickets).toHaveLength(PLAN_MAX);
    expect(h.tickets.at(-1)!.key).toBe("ACM-30");
    expect(h.over).toBe(4);
    expect(pickedSaid(h)).toEqual([`A plan has at most ${PLAN_MAX} tickets: the first ${PLAN_MAX} are handed over, and 4 left out.`]);
    expect(planAsk(ACME, h)).toContain(`(4 more were picked, but a plan has at most ${PLAN_MAX} tickets: they're left for another plan.)`);
  });

  it("asks the boss for a plan naming the board and each ticket by key and title", () => {
    const h = handover([ticket(465, { title: "Cart empties on reload" }), ticket(470, { title: "Checkout button misaligned" })], none);
    expect(planAsk({ ...ACME, name: "Mantis", prefix: "MAN" }, h)).toBe(
      "Make a plan for these 2 tickets on Mantis (MAN), taking each on as it is: ACM-465 “Cart empties on reload”, ACM-470 “Checkout button misaligned”.",
    );
    expect(planAsk(ACME, handover([ticket(1, { title: "Only one" })], none))).toBe("Make a plan for this ticket on Acme (ACM), taking it on as it is: ACM-1 “Only one”.");
    // A synced board by its target; a ticket not on its issue tracker yet by its title.
    const linear = { name: "Mantis", prefix: null, sync: { target: "MAN" } as never };
    expect(planAsk(linear, handover([ticket(2, { key: null, title: "New one" })], none))).toBe("Make a plan for this ticket on Mantis (MAN), taking it on as it is: “New one”.");
  });
});

describe("the boss who plans a board", () => {
  const main = { id: "sarah", name: "Sarah" };
  const manager = (over: Partial<Manager> = {}): Manager => ({ agentId: "sarah", level: "act", bosses: [{ agentId: "mo", name: "Mo", group: "g-shop", level: "act" }], sealed: ["g-secret"], ...over });

  it("is its group's own boss, else the main one", () => {
    expect(bossOfBoard({ group: "g-shop" }, manager(), main)).toEqual({ id: "mo", name: "Mo" });
    expect(bossOfBoard({ group: "g-other" }, manager(), main)).toEqual(main);
    expect(bossOfBoard({ group: null }, manager(), main)).toEqual(main);
  });

  it("is no one for a group closed to all but the person, or with no boss at all", () => {
    expect(bossOfBoard({ group: "g-secret" }, manager(), main)).toBeNull();
    expect(bossOfBoard({ group: null }, manager({ agentId: null }), null)).toBeNull();
  });
});

// ── On the board ─────────────────────────────────────────────────────────

const SARAH = { hubId: "local", id: "sarah", name: "Sarah", model: null, provider: null, isDefault: false };
const seed = (tickets: Ticket[], boss: boolean) => {
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://local.test", local: true, revision: "t" }],
    roster: [SARAH],
    activeAgent: null,
  });
  useOverview.setState({ manager: boss ? { agentId: "sarah", level: "act" } : null });
  useBoard.setState({ supported: true, boards: { [ACME.id]: ACME }, shown: ACME.id, open: null, plan: null, tickets: Object.fromEntries(tickets.map((t) => [t.id, t])) });
  usePlans.setState({ supported: true, plans: {}, details: {} });
};
const card = (key: string) => screen.getByRole("button", { name: new RegExp(`^${key}:`) });
const cmdClick = (el: HTMLElement) => fireEvent.click(el, { metaKey: true });
const bar = () => screen.getByRole("group", { name: "Pick tickets for a plan" });

beforeEach(() => {
  useDesk.setState({ hub: null, view: "board" });
  useFocus.setState({ where: null, nonce: 0, insert: null });
});
afterEach(() => {
  cleanup();
  deskState.remove(draftKey.dm("local/sarah"));
});

describe("picking tickets on the board", () => {
  const board = [
    ticket(1, { title: "Cart empties on reload" }),
    ticket(2, { title: "Checkout misaligned", state: "todo" }),
    ticket(3, { title: "Search flickers", state: "doing", assignee: API }),
    ticket(4, { title: "Promo code spaces" }),
  ];

  it("picks by ⌘-click, still opens on a plain click, and hands the picked to the boss's DM unsent", () => {
    seed(board, true);
    render(<Board />);
    cmdClick(card("ACM-1"));
    cmdClick(card("ACM-2"));
    // ⌘-click picked, and opened nothing.
    expect(useBoard.getState().open).toBeNull();
    expect(card("ACM-1").getAttribute("aria-label")).toBe("ACM-1: Cart empties on reload, picked for a plan");
    expect(within(bar()).getByText("2 picked")).toBeTruthy();
    expect(within(bar()).getByRole("status").textContent).toContain("2 tickets go to Sarah to plan, each taken on as it is.");
    // A started ticket can't be picked, and says why.
    cmdClick(card("ACM-3"));
    expect(card("ACM-3").getAttribute("aria-label")).toBe("ACM-3: Search flickers");
    expect(screen.getByText(/ACM-3 is started already: a plan takes on only tickets not started yet/)).toBeTruthy();
    // A plain click opens a ticket, as ever.
    fireEvent.click(card("ACM-4"));
    expect(useBoard.getState().open).toBe("t4");

    const openDm = vi.spyOn(useChat.getState(), "openDm");
    fireEvent.click(within(bar()).getByRole("button", { name: "Make a plan…" }));
    expect(openDm).toHaveBeenCalledWith("local/sarah");
    expect(useDesk.getState().view).toBe("rooms");
    expect(useFocus.getState()).toMatchObject({
      where: "agent:local/sarah",
      insert: "Make a plan for these 2 tickets on Acme (ACM), taking each on as it is: ACM-1 “Cart empties on reload”, ACM-2 “Checkout misaligned”.",
    });
    openDm.mockRestore();
  });

  it("takes what the board shows, as searched, from the board's menu", () => {
    seed(board, true);
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Boards" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Make a plan…/ }));
    // Every ticket not started yet; then, searched, only those it shows.
    expect(within(bar()).getByRole("button", { name: "Pick all shown · 3" })).toBeTruthy();
    // With "cart", ACM-1 alone is shown.
    fireEvent.change(screen.getByLabelText("Search tickets"), { target: { value: "cart" } });
    fireEvent.click(within(bar()).getByRole("button", { name: "Pick all shown · 1" }));
    expect(within(bar()).getByText("1 picked")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search tickets"), { target: { value: "" } });
    expect(card("ACM-1").getAttribute("aria-label")).toContain("picked for a plan");
    expect(card("ACM-2").getAttribute("aria-label")).toBe("ACM-2: Checkout misaligned");
  });

  it(`says so when more than ${PLAN_MAX} are picked, and hands over the first ${PLAN_MAX}`, () => {
    seed(many(32), true);
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Boards" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Make a plan…/ }));
    fireEvent.click(within(bar()).getByRole("button", { name: "Pick all shown · 32" }));
    expect(within(bar()).getByText(`A plan has at most ${PLAN_MAX} tickets: the first ${PLAN_MAX} are handed over, and 2 left out.`, { exact: false })).toBeTruthy();
    fireEvent.click(within(bar()).getByRole("button", { name: "Make a plan…" }));
    const insert = useFocus.getState().insert!;
    expect(insert).toMatch(/^Make a plan for these 30 tickets on Acme \(ACM\)/);
    expect(insert).toContain("(2 more were picked");
  });

  it("can't make a plan where the board's group has no boss, and says why", () => {
    seed(board, false);
    render(<Board />);
    fireEvent.click(screen.getByRole("button", { name: "Boards" }));
    const item = screen.getByRole("menuitem", { name: /^Make a plan…/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("This board’s group has no boss to plan it");
    act(() => item.click());
    cmdClick(card("ACM-1"));
    const make = within(bar()).getByRole("button", { name: "Make a plan…" }) as HTMLButtonElement;
    expect(make.disabled).toBe(true);
    expect(make.title).toBe("This board’s group has no boss to plan it");
  });
});

describe("the boss's composer", () => {
  const dm = () => {
    useChat.setState({
      activeAgent: "local/sarah",
      conversations: { "local/sarah": { ...emptyConversation(), connected: true } },
      histories: { "local/sarah": { state: "ready", messages: [], more: false, earlier: "idle", loadedAt: "2026-11-18T09:00:00.000Z" } },
    });
    return render(<Rooms />);
  };

  it("shows the plan asked for when the DM opens after it was handed over", () => {
    seed([], true);
    act(() => useFocus.setState({ where: "agent:local/sarah", nonce: 1, insert: "Make a plan for this ticket" }));
    dm();
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Make a plan for this ticket");
  });

  it("shows it in the DM even when a room was left open in Rooms", () => {
    seed([ticket(1, { title: "Cart empties on reload" })], true);
    useDesk.setState({ activeRoom: "r1", inbox: true, rooms: { r1: { id: "r1", name: "general" } as never } });
    const { unmount } = render(<Board />);
    cmdClick(card("ACM-1"));
    fireEvent.click(within(bar()).getByRole("button", { name: "Make a plan…" }));
    unmount();
    expect(useDesk.getState()).toMatchObject({ view: "rooms", activeRoom: null, inbox: false });
    dm();
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "Make a plan for this ticket on Acme (ACM), taking it on as it is: ACM-1 “Cart empties on reload”.",
    );
  });

  it("puts it after what's typed already, when the DM is open", () => {
    seed([], true);
    dm();
    const box = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "One more thing" } });
    act(() => useFocus.setState((s) => ({ where: "agent:local/sarah", nonce: s.nonce + 1, insert: "Make a plan for this ticket" })));
    expect(box.value).toBe("One more thing\n\nMake a plan for this ticket");
  });
});

describe("the plans a board shows", () => {
  it("are its own, and those that took on one of its tickets", async () => {
    const { plansOn } = await import("../crew/planStore");
    const plan = { id: "p1", board: "b-desk", state: "proposed", createdAt: "2026-11-18T09:00:00Z" } as never;
    const details = { p1: { tickets: [{ board: "b-desk" }, { board: "b-linear" }] } } as never;
    expect(plansOn({ p1: plan }, "b-desk").map((p) => p.id)).toEqual(["p1"]);
    expect(plansOn({ p1: plan }, "b-linear")).toEqual([]);
    expect(plansOn({ p1: plan }, "b-linear", details).map((p) => p.id)).toEqual(["p1"]);
    // An ended plan stays listed: the board shows it under Finished.
    expect(plansOn({ p1: { ...(plan as object), state: "dropped" } as never }, "b-linear", details).map((p) => p.id)).toEqual(["p1"]);
  });
});
