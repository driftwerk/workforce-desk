// A board's order (As on Jira, newest first …), what a drag does in each,
// and each board's view kept across switching and restarts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceOrder, Ticket } from "../hub/types";
import { restore } from "../restore/boot";
import { DeskStateStore, stable, type LocalState, type StateEntry } from "../restore/store";
import { anchored, byHand, columns, createdOf, defaultOrder, orderOn, ordersFor, sortedLanding, sourceSortOf, type BoardOrder } from "./board";
import { orderChipSays, orderSays, sortedSaid } from "./OrderChip";
import { ticket } from "./testing";
import { BOARD_VIEWS_KEY, boardViews, readViews, setBoardView, useBoardViews } from "./views";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  onNativeState: vi.fn(() => Promise.resolve(() => {})),
  subscribe: vi.fn(() => () => {}),
  stateLoad: vi.fn(),
  statePut: vi.fn(),
  stateRemove: vi.fn(),
  stateSynced: vi.fn(),
  stateAdopt: vi.fn(),
  stateFlush: vi.fn(),
}));

const NOW = Date.parse("2026-11-18T12:00:00Z");
const opts = (order: BoardOrder) => ({ filter: "all" as const, q: "", now: NOW, waiting: () => false, order });
const todo = (tickets: Ticket[], order: BoardOrder) => columns(tickets, opts(order)).find((c) => c.state === "todo")!.cards.map((t) => t.key);

// Made in the order 1, 2, 3; ranked by hand 3, 1, 2; changed last: 1.
const T = [
  ticket(1, { state: "todo", rank: 2048, createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-17T09:00:00Z" }),
  ticket(2, { state: "todo", rank: 3072, createdAt: "2026-11-02T09:00:00Z", updatedAt: "2026-11-03T09:00:00Z" }),
  ticket(3, { state: "todo", rank: 1024, createdAt: "2026-11-03T09:00:00Z", updatedAt: "2026-11-04T09:00:00Z" }),
];

describe("a board's order", () => {
  it("sorts each column newest first, oldest first, by last change, or as arranged", () => {
    expect(todo(T, "newest")).toEqual(["ACM-3", "ACM-2", "ACM-1"]);
    expect(todo(T, "oldest")).toEqual(["ACM-1", "ACM-2", "ACM-3"]);
    expect(todo(T, "changed")).toEqual(["ACM-1", "ACM-3", "ACM-2"]);
    expect(todo(T, "arranged")).toEqual(["ACM-3", "ACM-1", "ACM-2"]);
    // Not said: by rank, as boards always were.
    expect(columns(T, { filter: "all", q: "", now: NOW, waiting: () => false })[1]!.cards.map((t) => t.key)).toEqual(["ACM-3", "ACM-1", "ACM-2"]);
  });

  it("breaks a tie of dates by number, the newer first when newest is", () => {
    const same = [ticket(1, { state: "todo" }), ticket(2, { state: "todo" })];
    expect(todo(same, "newest")).toEqual(["ACM-2", "ACM-1"]);
    expect(todo(same, "oldest")).toEqual(["ACM-1", "ACM-2"]);
  });

  it("dates a synced ticket by its issue's own creation, not its import", () => {
    const issue = (n: number, created: string) =>
      ticket(n, { state: "todo", createdAt: "2026-11-18T08:00:00Z", external: { details: { created } } as Ticket["external"] });
    const synced = [issue(1, "2026-03-04T10:00:00Z"), issue(2, "2026-09-12T10:00:00Z")];
    expect(createdOf(synced[0]!)).toBe("2026-03-04T10:00:00Z");
    expect(todo(synced, "newest")).toEqual(["ACM-2", "ACM-1"]);
  });

  it("is as on Jira by Jira's rank, compared byte by byte, and as on Linear by its sort order", () => {
    const jira = [
      ticket(1, { state: "todo", rank: 1024, upstreamRank: "0|i0002b:" }),
      ticket(2, { state: "todo", rank: 2048, upstreamRank: "0|i0000Z:" }),
      ticket(3, { state: "todo", rank: 3072, upstreamRank: "0|i0000f:" }),
    ];
    // "Z" sorts before "f" byte by byte (a locale's order would differ).
    expect(todo(jira, "source")).toEqual(["ACM-2", "ACM-3", "ACM-1"]);
    const linear = [ticket(1, { state: "todo", upstreamRank: 10.5 }), ticket(2, { state: "todo", upstreamRank: -3 }), ticket(3, { state: "todo", upstreamRank: 2 })];
    expect(todo(linear, "source")).toEqual(["ACM-2", "ACM-3", "ACM-1"]);
  });

  it("is as on Jira by rank and number while the hub doesn't say the issue's place, those it doesn't say after", () => {
    expect(todo(T, "source")).toEqual(["ACM-3", "ACM-1", "ACM-2"]);
    const some = [ticket(1, { state: "todo", rank: 1024 }), ticket(2, { state: "todo", rank: 2048, upstreamRank: 5 }), ticket(3, { state: "todo", rank: 3072, upstreamRank: null })];
    expect(todo(some, "source")).toEqual(["ACM-2", "ACM-1", "ACM-3"]);
  });

  it("keeps Done's settled ones on its shelf in every order", () => {
    const done = [
      ticket(1, { state: "done", stateAt: "2026-11-01T09:00:00Z", createdAt: "2026-11-01T09:00:00Z" }),
      ticket(2, { state: "done", stateAt: "2026-11-18T09:00:00Z", createdAt: "2026-11-02T09:00:00Z" }),
      ticket(3, { state: "dropped", createdAt: "2026-11-03T09:00:00Z" }),
    ];
    for (const order of ["source", "newest", "oldest", "changed", "arranged"] as const) {
      const col = columns(done, opts(order)).find((c) => c.state === "done")!;
      expect(col.cards.map((t) => t.key)).toEqual(["ACM-2"]);
      expect(col.shelf.map((t) => t.key).sort()).toEqual(["ACM-1", "ACM-3"]);
    }
    expect(columns(done, opts("newest")).find((c) => c.state === "done")!.shelf.map((t) => t.key)).toEqual(["ACM-3", "ACM-1"]);
  });

  it("offers a synced board's own order first and a Desk-only board's hand order last, each its default", () => {
    expect(ordersFor(true)).toEqual(["source", "newest", "oldest", "changed"]);
    expect(ordersFor(false)).toEqual(["newest", "oldest", "changed", "arranged"]);
    expect(defaultOrder(true)).toBe("source");
    expect(defaultOrder(false)).toBe("newest");
    // Kept from before the board was linked or unlinked: its default instead.
    expect(orderOn("arranged", true)).toBe("source");
    expect(orderOn("source", false)).toBe("newest");
    expect(orderOn("oldest", true)).toBe("oldest");
    expect(orderOn(undefined, false)).toBe("newest");
  });

  it("says itself on its chip", () => {
    expect(orderChipSays("source", "jira")).toBe("Order: as on Jira");
    expect(orderChipSays("source", "linear")).toBe("Order: as on Linear");
    expect(orderChipSays("newest", null)).toBe("Order: newest first");
    expect(orderChipSays("arranged", null)).toBe("Order: as arranged");
  });
});

describe("a drag in each order", () => {
  const cols = columns(T, opts("newest"));
  it("moves a card by hand only as on Jira or Linear and as arranged", () => {
    expect(byHand("source", null)).toBe(true);
    expect(byHand("arranged", null)).toBe(true);
    for (const o of ["newest", "oldest", "changed"] as const) expect(byHand(o, null)).toBe(false);
  });

  it("only changes the column in a sorted order: dropped in its own, it stays and the board says why", () => {
    const t1 = T[0]!;
    expect(sortedLanding(cols, t1, { card: "t3", upper: true })).toBe("sorted");
    expect(sortedLanding(cols, t1, { column: "todo" })).toBe("sorted");
    // Another column: just its state, so it lands in its sorted place.
    expect(sortedLanding(cols, t1, { column: "doing" })).toEqual({ state: "doing" });
    expect(sortedSaid("newest", null)).toBe("Sorted newest first: choose As arranged to move cards by hand.");
    expect(sortedSaid("changed", "jira")).toBe("Sorted by recent change: choose As on Jira to move cards by hand.");
  });

  it("places a move as on Jira among the neighbours as the board shows them", () => {
    const jira = [
      ticket(1, { state: "todo", rank: 1024, upstreamRank: "c" }),
      ticket(2, { state: "todo", rank: 2048, upstreamRank: "a" }),
      ticket(3, { state: "todo", rank: 3072, upstreamRank: "b" }),
      ticket(4, { state: "backlog" }),
    ];
    // Shown a, b, c: dropped after ACM-2 ("a") is ahead of ACM-3 ("b"), not ACM-3 by rank.
    expect(anchored({ state: "todo", before: "t2" }, jira, "t4", "source")).toEqual({ state: "todo", before: "t2", after: "t3" });
    expect(anchored({ state: "todo", before: "t3" }, jira, "t4", "source")).toEqual({ state: "todo", before: "t3", after: "t1" });
    // By rank, ACM-3 would be last.
    expect(anchored({ state: "todo", before: "t3" }, jira, "t4")).toEqual({ state: "todo", before: "t3" });
  });
});

/** Desk's file, as its native side keeps it. */
const fakeFile = (initial: Record<string, StateEntry> = {}) => {
  const entries: Record<string, StateEntry> = structuredClone(initial);
  const local: LocalState & { entries: typeof entries } = {
    entries,
    load: async () => structuredClone(entries),
    put: async (key, value) => void (entries[key] = { value: structuredClone(value), updatedAt: null, dirty: true }),
    remove: async (key) => void delete entries[key],
    synced: async (key, value, updatedAt) => {
      if (entries[key] && stable(entries[key].value) === stable(value)) entries[key] = { value, updatedAt, dirty: false };
    },
    adopt: async () => true,
    flush: async () => {},
  };
  return local;
};

const started = async (file: LocalState) => {
  const store = new DeskStateStore(file, 0);
  await store.load();
  await store.connect(null);
  return store;
};

describe("each board's view", () => {
  beforeEach(() => useBoardViews.setState({ views: {} }));

  it("comes back after a restart: its order, quick filter and own filters, each board its own", async () => {
    const file = fakeFile();
    const stop = restore(await started(file), boardViews);
    setBoardView("b-plt", { order: "newest", facets: { epic: "Audit Service" } });
    setBoardView("b-vel", { order: "arranged", filter: "mine" });
    stop();
    expect(file.entries[BOARD_VIEWS_KEY]?.value).toEqual({
      views: { "b-plt": { order: "newest", facets: { epic: "Audit Service" } }, "b-vel": { order: "arranged", filter: "mine" } },
    });
    useBoardViews.setState({ views: {} });
    restore(await started(fakeFile(file.entries)), boardViews)();
    expect(useBoardViews.getState().views).toEqual({
      "b-plt": { order: "newest", facets: { epic: "Audit Service" } },
      "b-vel": { order: "arranged", filter: "mine" },
    });
  });

  it("drops what it can't read, keeping the rest, and shows the defaults for nothing kept", () => {
    expect(readViews(null)).toEqual({});
    expect(readViews("garbled")).toEqual({});
    expect(readViews({ views: [1, 2] })).toEqual({});
    expect(
      readViews({
        views: {
          a: { order: "sideways", filter: "nobody", facets: "epic" },
          b: { order: "oldest", filter: 7, facets: { epic: "Audit", type: 3, colour: "red", sprint: "" } },
          c: null,
          d: { filter: "pinned" },
        },
      }),
    ).toEqual({ b: { order: "oldest", facets: { epic: "Audit" } }, d: { filter: "pinned" } });
    boardViews.write({ views: { x: { order: 12 } } });
    expect(useBoardViews.getState().views).toEqual({});
    expect(orderOn(useBoardViews.getState().views.x?.order, false)).toBe("newest");
  });
});

describe("as on Jira or Linear, ordered there by more than its rank", () => {
  const ordering = (by: SourceOrder["by"], extra: Partial<SourceOrder> = {}): SourceOrder => ({ by, readAt: "2026-11-18T10:00:00Z", ...extra });
  const linear = (n: number, priorityRank: number | undefined, prioritySort: number | undefined, sortOrder: number) =>
    ticket(n, {
      state: "todo",
      upstreamRank: sortOrder,
      external: { system: "linear", remoteUpdatedAt: "2026-11-10T00:00:00Z", details: { priorityRank, prioritySort } } as Ticket["external"],
    });
  // Manual order 1, 2, 3, 4; Urgent: 3, then 2 (by its priority order);
  // 1 has none.
  const L = [linear(1, undefined, 1, 1), linear(2, 1, 5, 2), linear(3, 1, 2, 3), linear(4, 3, 1, 4)];
  const byPriority = sourceSortOf({ ordering: ordering([{ field: "priority", desc: true }, { field: "prioritySort" }]) });
  const shown = (tickets: Ticket[], source: ReturnType<typeof sourceSortOf>) =>
    columns(tickets, { ...opts("source"), source }).find((c) => c.state === "todo")!.cards.map((t) => t.key);

  it("sorts as Linear's priority does: the most urgent first, ties by Linear's priority order, none last", () => {
    expect(shown(L, byPriority)).toEqual(["ACM-3", "ACM-2", "ACM-4", "ACM-1"]);
    // Read before it was kept, or by hand there: the manual order.
    expect(shown(L, null)).toEqual(["ACM-1", "ACM-2", "ACM-3", "ACM-4"]);
    expect(shown(L, sourceSortOf({ ordering: ordering([{ field: "manual" }]) }))).toEqual(["ACM-1", "ACM-2", "ACM-3", "ACM-4"]);
    // Couldn't follow it: as before.
    expect(shown(L, sourceSortOf({ ordering: ordering([], { note: "…" }) }))).toEqual(["ACM-1", "ACM-2", "ACM-3", "ACM-4"]);
  });

  it("sorts as a Jira site's own priorities go, and an empty value as Jira does", () => {
    const jira = (n: number, priority: string | undefined, due: string | undefined, rank: string) =>
      ticket(n, { state: "todo", upstreamRank: rank, external: { system: "jira", remoteUpdatedAt: "2026-11-10T00:00:00Z", details: { priority, due } } as Ticket["external"] });
    const J = [jira(1, "Low", "2026-12-01", "a"), jira(2, "Highest", undefined, "b"), jira(3, "Medium", "2026-11-20", "c"), jira(4, "Highest", "2026-11-25", "d")];
    const priorities = ["Highest", "High", "Medium", "Low", "Lowest"];
    const s = (by: SourceOrder["by"]) => sourceSortOf({ ordering: ordering(by), fields: { priorities } });
    // Highest first, ties by Rank.
    expect(shown(J, s([{ field: "priority", desc: true, emptyFirst: true }]))).toEqual(["ACM-2", "ACM-4", "ACM-3", "ACM-1"]);
    // Due going up: the soonest first, none last; going down, none first.
    expect(shown(J, s([{ field: "due" }]))).toEqual(["ACM-3", "ACM-4", "ACM-1", "ACM-2"]);
    expect(shown(J, s([{ field: "due", desc: true, emptyFirst: true }]))).toEqual(["ACM-2", "ACM-1", "ACM-4", "ACM-3"]);
  });

  it("moves a card by hand only while the board there is ordered by hand, and says why not", () => {
    expect(byHand("source", byPriority)).toBe(false);
    expect(byHand("source", sourceSortOf({ ordering: ordering([{ field: "rank" }]) }))).toBe(true);
    expect(byHand("source", sourceSortOf({ ordering: ordering([{ field: "rank", desc: true }]) }))).toBe(false);
    expect(byHand("source", null)).toBe(true);
    const prio = ordering([{ field: "priority", desc: true }]);
    expect(sortedSaid("source", "linear", prio)).toBe("Linear sorts this board by priority, so dragging a card up or down doesn't reorder it; reorder it in Linear.");
  });

  it("names the ordering it follows on its chip", () => {
    expect(orderChipSays("source", "linear", ordering([{ field: "priority", desc: true }]))).toBe("Order: as on Linear · by priority");
    expect(orderChipSays("source", "linear", ordering([], { note: "…" }))).toBe("Order: as on Linear · manual order");
    expect(orderChipSays("source", "jira", ordering([{ field: "rank" }]))).toBe("Order: as on Jira · by rank");
    expect(orderChipSays("source", "jira", ordering([{ field: "created", desc: true }]))).toBe("Order: as on Jira · newest first");
    expect(orderChipSays("source", "jira", null)).toBe("Order: as on Jira");
  });

  it("falls back sensibly where a value or a list is missing", () => {
    const jira = (n: number, priority: string, priorityRank: number, rank: string) =>
      ticket(n, { state: "todo", upstreamRank: rank, external: { system: "jira", remoteUpdatedAt: "2026-11-10T00:00:00Z", details: { priority, priorityRank } } as Ticket["external"] });
    const J = [jira(1, "low", 4, "a"), jira(2, "Highest", 1, "b"), jira(3, "Nope", 2, "c")];
    // Names matched whatever their case; one the site doesn't list is empty.
    const listed = sourceSortOf({ ordering: ordering([{ field: "priority", desc: true }]), fields: { priorities: ["Highest", "High", "Low"] } });
    expect(shown(J, listed)).toEqual(["ACM-2", "ACM-1", "ACM-3"]);
    // The site's priorities unread: by its bars.
    expect(shown(J, sourceSortOf({ ordering: ordering([{ field: "priority", desc: true }]) }))).toEqual(["ACM-2", "ACM-3", "ACM-1"]);
    // Updated: its issue's change there, and one without isn't Desk's import time.
    const u = (n: number, remote: string | undefined) =>
      ticket(n, { state: "todo", upstreamRank: `${n}`, updatedAt: "2026-11-18T11:00:00Z", external: { system: "linear", remoteUpdatedAt: remote, details: {} } as unknown as Ticket["external"] });
    expect(shown([u(1, "2026-11-01T00:00:00Z"), u(2, undefined), u(3, "2026-11-05T00:00:00Z")], sourceSortOf({ ordering: ordering([{ field: "updated", desc: true }]) }))).toEqual(["ACM-3", "ACM-1", "ACM-2"]);
    // Rank going down keeps those without a place last.
    const r = [ticket(1, { state: "todo", upstreamRank: "a" }), ticket(2, { state: "todo" }), ticket(3, { state: "todo", upstreamRank: "b" })];
    expect(shown(r, sourceSortOf({ ordering: ordering([{ field: "rank", desc: true }]) }))).toEqual(["ACM-3", "ACM-1", "ACM-2"]);
    // A key this Desk doesn't know ends the list: as by hand.
    const newer = sourceSortOf({ ordering: ordering([{ field: "title" as never }]) });
    expect(newer?.by).toEqual([]);
    expect(byHand("source", newer)).toBe(true);
  });

  it("breaks a tie by the next key, then by Rank, whatever order the cards come in", () => {
    const L2 = [linear(1, 2, 9, 4), linear(2, 2, 1, 3), linear(3, 1, 5, 2), linear(4, undefined, 1, 1), linear(5, 2, 1, 0)];
    const want = ["ACM-3", "ACM-5", "ACM-2", "ACM-1", "ACM-4"];
    expect(shown(L2, byPriority)).toEqual(want);
    expect(shown([...L2].reverse(), byPriority)).toEqual(want);
    expect(shown([L2[2]!, L2[0]!, L2[4]!, L2[3]!, L2[1]!], byPriority)).toEqual(want);
    // Least urgent first: no priority still last, as Linear puts it.
    expect(shown(L2, sourceSortOf({ ordering: ordering([{ field: "priority" }, { field: "prioritySort" }]) }))).toEqual(["ACM-5", "ACM-2", "ACM-1", "ACM-3", "ACM-4"]);
  });

  it("says where its order comes from, and how it sorts, in the menu", () => {
    expect(orderSays("source", "linear", ordering([{ field: "priority", desc: true }], { from: "your own view settings" }))).toBe("The board's own order, from your own view settings");
    expect(orderSays("source", "jira", ordering([{ field: "due" }]))).toBe("The board's own order, as Jira sorts it");
    expect(orderSays("source", "jira", ordering([{ field: "rank" }]))).toBe("The board's own order, as Jira ranks it");
    expect(orderChipSays("source", "linear", ordering([{ field: "priority" }]))).toBe("Order: as on Linear · by priority, lowest first");
  });
});
