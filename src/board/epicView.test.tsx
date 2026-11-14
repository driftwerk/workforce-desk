// An epic's view (EpicDetail): which Desk column each child counts in, its
// progress by them, its children grouped by state (or who has them, or
// type, or not at all) with done ones folded after two, and the rows,
// progress bar and fold as drawn.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, Ticket, TicketChild, TicketDetails, TicketState } from "../hub/types";
import { useBoard } from "./store";
import { TicketDetail } from "./TicketDetail";
import { ActivityFold, EpicChildren, EpicProgress, stateTone } from "./TicketSections";
import { bylineText, childColumn, childGroups, epicProgress, factOrder, isEpic } from "./ticketRich";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(), unregister: vi.fn() }));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));
import { ACME, ticket } from "./testing";

afterEach(cleanup);

const child = (key: string, state: string, stateKind: string, over: Partial<TicketChild> = {}): TicketChild => ({
  key,
  title: `Work ${key}`,
  kind: "Story",
  kindLevel: 0,
  state,
  stateKind,
  done: stateKind === "done",
  started: stateKind === "indeterminate",
  ...over,
});

// The mockup's epic: one doing, one in review, two to do (one blocked),
// one in the backlog, seven done.
const CHILDREN: TicketChild[] = [
  child("ACM-11", "In Progress", "indeterminate", { assignee: "Sam Lee", priorityRank: 1, points: 5, prs: { count: 2, state: "review" } }),
  child("ACM-12", "In Review", "indeterminate", { assignee: "Dana Kim", priorityRank: 3, points: 3, prs: { count: 1, state: "changes", number: 612 } }),
  child("ACM-13", "Blocked", "new", { assignee: "Alex Park", priorityRank: 3, points: 5 }),
  child("ACM-14", "To Do", "new", { assignee: "Sam Lee", priorityRank: 3, points: 3 }),
  child("ACM-15", "Backlog", "new", { priorityRank: 4, points: 3 }),
  child("ACM-16", "Done", "done", { kind: "Task", assignee: "Alex Park", points: 2, prs: { count: 2, state: "merged" } }),
  child("ACM-17", "Done", "done", { assignee: "Sam Lee", points: 5, prs: { count: 1, state: "merged", number: 587 } }),
  child("ACM-18", "Done", "done", { assignee: "Alex Park", points: 5 }),
  child("ACM-19", "Done", "done", { assignee: "Sam Lee", points: 3 }),
  child("ACM-20", "Done", "done", { kind: "Task", assignee: "Dana Kim", points: 5 }),
  child("ACM-21", "Done", "done", { kind: "Task", assignee: "Alex Park", points: 3 }),
  child("ACM-22", "Done", "done", { assignee: "Sam Lee", points: 5 }),
];

const byName = (c: TicketChild): TicketState => childColumn(c, undefined);

const DETAILS: TicketDetails = {
  kind: "Epic",
  kindLevel: 1,
  reporter: "Dana Kim",
  created: "2026-09-01T10:00:00Z",
  due: "2026-12-12",
  priorityRank: 1,
  priority: "Now",
  subItems: { done: 7, total: 12, started: 2 },
  childPoints: { done: 28, total: 47 },
  childBlocked: 1,
  children: CHILDREN,
};

const epic = (details: TicketDetails = DETAILS, over: Partial<Ticket> = {}): Ticket =>
  ticket(10, {
    external: { system: "jira", key: "ACM-10", url: "https://example.test/browse/ACM-10", remoteUpdatedAt: "2026-11-02T09:00:00Z", synced: true, link: "l", details },
    ...over,
  });

describe("which column an epic's child counts in", () => {
  it("is its own ticket's here first, then the board's state map, then its state's words", () => {
    const c = child("ACM-1", "Ready for QA", "indeterminate");
    expect(childColumn(c, "done", { review: "Ready for QA" })).toBe("done");
    expect(childColumn(c, undefined, { review: "ready for qa" })).toBe("review");
    expect(childColumn(c, undefined)).toBe("doing");
  });

  it("reads the words: review, backlog, done or dropped, started, and a Blocked that isn't done is to do", () => {
    expect(CHILDREN.slice(0, 6).map(byName)).toEqual(["doing", "review", "todo", "todo", "backlog", "done"]);
    expect(byName(child("A-1", "Won't Do", "done"))).toBe("dropped");
    expect(byName(child("A-2", "Blocked", "indeterminate"))).toBe("todo");
    expect(byName(child("A-3", "Triage", "backlog"))).toBe("backlog");
    expect(byName(child("A-4", "Canceled", "canceled", { done: false }))).toBe("dropped");
  });
});

describe("an epic's progress", () => {
  it("counts its children and their points by Desk's columns: done, doing and review, the rest; dropped ones not at all", () => {
    expect(epicProgress(DETAILS, byName)).toEqual({ total: 12, done: 7, moving: 2, rest: 3, pct: 58, points: { done: 28, total: 47 }, blocked: 1 });
    // The hub counts a Won't Do child as done, and its points; Desk doesn't.
    const dropped = { ...DETAILS, subItems: { done: 8, total: 13, started: 2 }, childPoints: { done: 36, total: 55 }, children: [...CHILDREN, child("ACM-30", "Won't Do", "done", { points: 8 })] };
    expect(epicProgress(dropped, byName)).toMatchObject({ total: 12, done: 7, points: { done: 28, total: 47 } });
  });

  it("says its percent rounded down, and no points when they add up to none", () => {
    const three = [child("A-1", "Done", "done", { points: 0 }), child("A-2", "Done", "done", { points: 0 }), child("A-3", "To Do", "new")];
    expect(epicProgress({ children: three }, byName)).toMatchObject({ pct: 66, points: undefined });
    expect(epicProgress({ subItems: { done: 1, total: 3 }, childPoints: { done: 0, total: 0 } }, byName).points).toBeUndefined();
  });

  it("without its children listed, is what the hub counted", () => {
    expect(epicProgress({ subItems: { done: 3, total: 10, started: 2 }, childPoints: { done: 5, total: 20 } }, byName)).toMatchObject({ total: 10, done: 3, moving: 2, rest: 5, pct: 30, points: { done: 5, total: 20 } });
    expect(epicProgress({}, byName).total).toBe(0);
  });
});

describe("an epic's children in groups", () => {
  const keys = (g: ReturnType<typeof childGroups>) => g.map((x) => [x.title, x.rows.map((c) => c.key), x.folded, x.count, x.points]);

  it("by state: doing, review, to do, backlog, done, in the hub's order within, done folded after two", () => {
    expect(keys(childGroups(CHILDREN, byName, "state"))).toEqual([
      ["Doing", ["ACM-11"], 0, 1, 5],
      ["Review", ["ACM-12"], 0, 1, 3],
      ["To do", ["ACM-13", "ACM-14"], 0, 2, 8],
      ["Backlog", ["ACM-15"], 0, 1, 3],
      ["Done", ["ACM-16", "ACM-17"], 5, 7, 28],
    ]);
  });

  it("unfolded, shows every done one in that group alone; with done hidden, leaves them and their group out", () => {
    expect(childGroups(CHILDREN, byName, "state", { unfold: new Set(["done"]) }).at(-1)!.rows).toHaveLength(7);
    const people = childGroups(CHILDREN, byName, "assignee", { unfold: new Set(["Sam Lee"]) });
    expect(people.map((g) => g.folded)).toEqual([1, 0, 0, 0]);
    expect(people[2]!.rows.map((c) => c.key)).toEqual(["ACM-11", "ACM-14", "ACM-17", "ACM-19", "ACM-22"]);
    expect(childGroups(CHILDREN, byName, "state", { hideDone: true }).map((g) => g.title)).toEqual(["Doing", "Review", "To do", "Backlog"]);
  });

  it("by who has them, by name with No one last, each by state and done folded after two", () => {
    const g = childGroups(CHILDREN, byName, "assignee");
    expect(g.map((x) => x.title)).toEqual(["Alex Park", "Dana Kim", "Sam Lee", "No one"]);
    expect(keys(g)[0]).toEqual(["Alex Park", ["ACM-13", "ACM-16", "ACM-18"], 1, 4, 15]);
    expect(keys(g)[2]).toEqual(["Sam Lee", ["ACM-11", "ACM-14", "ACM-17", "ACM-19"], 1, 5, 21]);
  });

  it("by type, in the order first seen; or all in one group without a head", () => {
    expect(childGroups(CHILDREN, byName, "type").map((x) => [x.title, x.count])).toEqual([
      ["Story", 9],
      ["Task", 3],
    ]);
    const one = childGroups(CHILDREN, byName, "none");
    expect(one).toHaveLength(1);
    expect(one[0]!.title).toBeNull();
    expect(one[0]!.rows.map((c) => c.key)).toEqual(["ACM-11", "ACM-12", "ACM-13", "ACM-14", "ACM-15", "ACM-16", "ACM-17"]);
    expect(one[0]!.folded).toBe(5);
  });

  it("sums points only where children have them", () => {
    expect(childGroups([child("A-1", "To Do", "new")], byName, "state")[0]!.points).toBeNull();
  });
});

describe("an epic's words", () => {
  it("is a Jira issue at level 1 or named Epic; Linear has no epics", () => {
    expect(isEpic(epic())).toBe(true);
    expect(isEpic(epic({ kind: "Initiative", kindLevel: 1 }))).toBe(true);
    expect(isEpic(epic({ kind: "Story", kindLevel: 0 }))).toBe(false);
    expect(isEpic(ticket(1, { external: { system: "linear", key: "M-1", url: "", remoteUpdatedAt: "", synced: true, link: "l", details: { kind: "Epic" } } }))).toBe(false);
  });

  it("says its child count in its byline where a story says its dates", () => {
    expect(bylineText(epic(), "wide", 12)).toBe("Epic · written by Dana Kim on Jira · 12 child items");
    expect(bylineText(epic(), "compact", 1)).toBe("Epic · Dana Kim on Jira · 1 child item");
    expect(bylineText(epic(), "wide")).toBe("Epic · written by Dana Kim on Jira");
  });

  it("colours a child's state by what it says", () => {
    expect(CHILDREN.slice(0, 6).map((c) => stateTone(c.state, c.done, c))).toEqual([
      "ticket-tone-working",
      "ticket-tone-working",
      "ticket-tone-blocked",
      "muted",
      "ticket-tone-faint",
      "state-done",
    ]);
    // A sub-item's and a link's, said by their state alone, as before.
    expect(stateTone("In Progress")).toBe("ticket-tone-working");
    expect(stateTone("To Do")).toBe("muted");
    expect(stateTone("Anything", true)).toBe("state-done");
  });

  it("lists its children before its points in the details", () => {
    expect(factOrder("jira", (f) => ["type", "state", "priority", "children", "points", "due"].includes(f))).toEqual(["type", "state", "priority", "children", "points", "due"]);
  });
});

describe("an epic, drawn", () => {
  const board: Board = {
    ...ACME,
    sync: { link: "l", system: "jira", target: "ACM", via: { kind: "thisHub" }, person: "p", filter: { kind: "assignedToMe" }, states: {}, meName: "Sam Lee" },
  };
  beforeEach(() => {
    const t = epic();
    // ACM-13 is on the board here, in Review: its column is Desk's.
    const here = ticket(13, { state: "review", external: { system: "jira", key: "ACM-13", url: "https://example.test/browse/ACM-13", remoteUpdatedAt: "", synced: true, link: "l", details: { priorityRank: 3, priority: "Next" } } });
    useBoard.setState({ boards: { [board.id]: board }, tickets: { [t.id]: t, [here.id]: here } });
  });

  it("draws its progress: the percent, done and points, due day, the bar's three parts and the blocked count", () => {
    render(<EpicProgress ticket={epic()} />);
    const p = screen.getByRole("region", { name: "Progress" });
    expect(p.textContent).toContain("58%");
    expect(p.textContent).toContain("7 of 12 done · 28 of 47 points");
    expect(p.textContent).toContain("due Dec 12");
    // ACM-13 counts as review now: its ticket here says so.
    expect(within(p).getByRole("img").getAttribute("aria-label")).toBe("7 done, 3 in doing or review, 2 to do, of 12");
    expect(within(p).getByRole("img").querySelectorAll("i")).toHaveLength(3);
    expect(p.textContent).toContain("1 blocked");
  });

  it("draws its children grouped by state, rows with priority bars named in a tooltip, points, PR and state, done folded", () => {
    render(<EpicChildren ticket={epic()} />);
    const heads = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(heads).toEqual(["Doing1 · 5 pts", "Review2 · 8 pts", "To do1 · 3 pts", "Backlog1 · 3 pts", "Done7 · 28 pts"]);
    const review = screen.getByRole("group", { name: "Review" });
    const rows = within(review).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("ACM-12"), expect.stringContaining("ACM-13")]);
    expect(rows[0]!.textContent).toContain("3 pts");
    expect(rows[0]!.textContent).toContain("#612");
    expect(rows[0]!.querySelector(".ticket-row-prio title")?.textContent).toBe("Next");
    expect(rows[1]!.querySelector(".ticket-tone-blocked")?.textContent).toBe("Blocked");
    const done = screen.getByRole("group", { name: "Done" });
    expect(within(done).getAllByRole("button", { name: /ACM-/ })).toHaveLength(2);
    // Done, its priority no longer shows.
    expect(done.querySelector(".ticket-row-prio")).toBeNull();
    fireEvent.click(within(done).getByRole("button", { name: "5 more done" }));
    expect(within(screen.getByRole("group", { name: "Done" })).getAllByRole("button", { name: /ACM-/ })).toHaveLength(7);
  });

  it("groups by who has them or not at all, and hides done ones", () => {
    render(<EpicChildren ticket={epic()} />);
    expect(screen.getByRole("button", { name: "State" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Assignee" }));
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.firstChild?.textContent)).toEqual(["Alex Park", "Dana Kim", "Sam Lee", "No one"]);
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Hide done" }));
    expect(screen.queryByText("Work ACM-16")).toBeNull();
    expect(screen.queryByRole("button", { name: /more done/ })).toBeNull();
  });

  it("says one count everywhere when the hub's differs: a Won't Do child counts nowhere, nor do its points", () => {
    // The hub says 13 children, 8 done, 36 of 55 points; Desk's columns say 12, 7, 28 of 47.
    const t = epic({ ...DETAILS, subItems: { done: 8, total: 13, started: 2 }, childPoints: { done: 36, total: 55 }, children: [...CHILDREN, child("ACM-30", "Won't Do", "done", { points: 8 })] });
    useBoard.setState({ tickets: { ...useBoard.getState().tickets, [t.id]: t } });
    render(<TicketDetail ticket={t} />);
    // The byline, the progress line, the list's head, and the Children and Points facts.
    expect(screen.getByText("Epic · written by Dana Kim on Jira · 12 child items")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Progress" }).textContent).toContain("7 of 12 done · 28 of 47 points");
    const list = screen.getByRole("region", { name: "Child items" });
    expect(list.querySelector(".ticket-sec-note")?.textContent).toBe("12");
    expect(document.querySelector(".ticket-fact-children")?.textContent).toBe("127 done");
    expect(document.querySelector(".ticket-fact-points")?.textContent).toBe("28 / 47");
    // It still lists, under Dropped.
    expect(within(screen.getByRole("group", { name: "Dropped" })).getByText("Work ACM-30")).toBeTruthy();
  });

  it("with done hidden and every child done, says so", () => {
    const t = epic({ ...DETAILS, children: CHILDREN.slice(5) });
    render(<EpicChildren ticket={t} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide done" }));
    expect(screen.getByText("All 7 done")).toBeTruthy();
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
  });

  it("unfolds one group's done ones, not every group's", () => {
    render(<EpicChildren ticket={epic()} />);
    fireEvent.click(screen.getByRole("button", { name: "Assignee" }));
    const sam = screen.getByRole("group", { name: "Sam Lee" });
    fireEvent.click(within(sam).getByRole("button", { name: "1 more done" }));
    expect(within(screen.getByRole("group", { name: "Sam Lee" })).queryByRole("button", { name: /more done/ })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Alex Park" })).getByRole("button", { name: "1 more done" })).toBeTruthy();
  });

  it("folds its comments and history, closed until asked", () => {
    const { container } = render(<ActivityFold ticket={epic()} layout="compact" />);
    const fold = container.querySelector("details")!;
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary")!.textContent).toMatch(/^Comments and history/);
    expect(within(fold).getByRole("region", { name: "Activity" })).toBeTruthy();
  });
});
