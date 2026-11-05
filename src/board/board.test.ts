import { describe, expect, it } from "vitest";
import type { LedgerRow, Ticket } from "../hub/types";
import {
  SETTLE_AFTER_MS,
  blockers,
  columns,
  dropAt,
  historyLine,
  keyOf,
  keyParts,
  landing,
  lineAt,
  matches,
  moved,
  needsLine,
  nudge,
  rankBetween,
  ready,
  sessionsOf,
  settled,
  snoozed,
  spendOf,
} from "./board";
import { API, WEB, ticket } from "./testing";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const all = (...ts: Ticket[]) => Object.fromEntries(ts.map((t) => [t.id, t]));
const states = (...ts: Ticket[]) => new Map(ts.map((t) => [t.id, t.state] as const));
const ids = (ts: Ticket[]) => ts.map((t) => t.id);
const everything = { filter: "all" as const, q: "", now: NOW, waiting: () => false };

describe("the board's columns", () => {
  it("are the five, each by rank, with Dropped and settled Done folded under Done", () => {
    const old = new Date(NOW - SETTLE_AFTER_MS - 1).toISOString();
    const tickets = [
      ticket(1, { state: "todo", rank: 3000 }),
      ticket(2, { state: "todo", rank: 1000 }),
      ticket(3, { state: "doing" }),
      ticket(4, { state: "done", stateAt: old }),
      ticket(5, { state: "done" }),
      ticket(6, { state: "dropped" }),
    ];
    const cols = columns(tickets, everything);
    expect(cols.map((c) => c.title)).toEqual(["Backlog", "To do", "Doing", "Review", "Done"]);
    expect(ids(cols[1]!.cards)).toEqual(["t2", "t1"]);
    expect(ids(cols[2]!.cards)).toEqual(["t3"]);
    expect(ids(cols[4]!.cards)).toEqual(["t5"]);
    expect(ids(cols[4]!.shelf)).toEqual(["t4", "t6"]);
  });

  it("hide a snoozed ticket until its time, and show it once the time has come", () => {
    const later = ticket(1, { snoozed: true, snoozedUntil: new Date(NOW + 60_000).toISOString() });
    const over = ticket(2, { snoozed: true, snoozedUntil: new Date(NOW - 60_000).toISOString() });
    expect(ids(columns([later, over], everything)[0]!.cards)).toEqual(["t2"]);
    expect(snoozed(later, NOW + 120_000)).toBe(false);
  });

  it("show what waits on you (Review, and what its session needs you for), or what's pinned, when filtered", () => {
    const tickets = [ticket(1, { pinned: true }), ticket(2, { state: "review" }), ticket(3), ticket(4, { state: "doing", assignee: API }), ticket(5, { state: "done", assignee: API })];
    const waiting = (t: Ticket) => t.assignee?.id === API.id;
    expect(columns(tickets, { ...everything, filter: "waiting", waiting }).flatMap((c) => ids(c.cards))).toEqual(["t4", "t2"]);
    expect(columns(tickets, { ...everything, filter: "pinned" }).flatMap((c) => ids(c.cards))).toEqual(["t1"]);
  });

  it("show what a search finds: a typed key exactly, else every word anywhere", () => {
    const tickets = [ticket(1, { title: "Hash partner keys" }), ticket(12, { title: "Docs", body: "rotation guide for partner keys" }), ticket(120)];
    const found = (q: string) => columns(tickets, { ...everything, q }).flatMap((c) => ids(c.cards));
    expect(found("acm-12")).toEqual(["t12"]);
    expect(found("partner keys")).toEqual(["t1", "t12"]);
    expect(found("rotation")).toEqual(["t12"]);
    expect(keyOf(" acm-012 ")).toBe("ACM-12");
    expect(keyOf("ACM-0")).toBeNull();
    expect(matches(ticket(3), "")).toBe(true);
  });
});

describe("settled and ready", () => {
  it("settles Done after three days and Dropped at once", () => {
    expect(settled({ state: "done", stateAt: new Date(NOW - SETTLE_AFTER_MS + 1000).toISOString() }, NOW)).toBe(false);
    expect(settled({ state: "done", stateAt: new Date(NOW - SETTLE_AFTER_MS).toISOString() }, NOW)).toBe(true);
    expect(settled({ state: "dropped", stateAt: new Date(NOW).toISOString() }, NOW)).toBe(true);
    expect(settled({ state: "review", stateAt: "2020-01-01T00:00:00Z" }, NOW)).toBe(false);
  });

  it("is ready in To do once every need is done, and blocked by those that aren't", () => {
    const a = ticket(1, { state: "done" });
    const b = ticket(2, { state: "doing" });
    const c = ticket(3, { state: "todo", needs: ["t1", "t2"] });
    expect(blockers(c, states(a, b, c))).toEqual(["t2"]);
    expect(ready(c, states(a, b, c))).toBe(false);
    expect(ready(c, states(a, { ...b, state: "done" }, c))).toBe(true);
    expect(ready({ ...c, state: "backlog" }, states(a, { ...b, state: "done" }))).toBe(false);
    // A need the board doesn't have isn't done.
    expect(blockers(ticket(4, { needs: ["gone"] }), states(a))).toEqual(["gone"]);
    expect(needsLine(c, all(a, b, c))).toBe("needs ACM-2");
    expect(needsLine(a, all(a))).toBeNull();
  });
});

describe("where a card lands", () => {
  const cols = columns([ticket(1, { state: "todo" }), ticket(2, { state: "todo" }), ticket(3, { state: "todo" }), ticket(4, { state: "doing" })], everything);

  it("is after the card above it and ahead of the one below", () => {
    expect(dropAt("todo", ["a", "b"], 1)).toEqual({ state: "todo", before: "a", after: "b" });
    expect(dropAt("todo", ["a", "b"], 0)).toEqual({ state: "todo", after: "a" });
    expect(dropAt("todo", ["a", "b"], 2)).toEqual({ state: "todo", before: "b" });
    expect(dropAt("review", [], 0)).toEqual({ state: "review" });
  });

  it("follows the pointer: above a card's middle, before it; below, after it; in a column's space, at its end", () => {
    expect(lineAt(cols, { card: "t2", upper: true })).toEqual({ state: "todo", before: "t2" });
    expect(lineAt(cols, { card: "t3", upper: false })).toEqual({ state: "todo", before: null });
    expect(landing(cols, "t3", { card: "t1", upper: true })).toEqual({ state: "todo", after: "t1" });
    expect(landing(cols, "t1", { card: "t3", upper: false })).toEqual({ state: "todo", before: "t3" });
    expect(landing(cols, "t1", { card: "t4", upper: true })).toEqual({ state: "doing", after: "t4" });
    expect(landing(cols, "t4", { column: "review" })).toEqual({ state: "review" });
    expect(landing(cols, "t4", { column: "todo" })).toEqual({ state: "todo", before: "t3" });
  });

  it("is nowhere new where it already is", () => {
    expect(landing(cols, "t2", { card: "t2", upper: true })).toBeNull();
    expect(landing(cols, "t2", { card: "t1", upper: false })).toBeNull();
    expect(landing(cols, "t2", { card: "t3", upper: true })).toBeNull();
    expect(landing(cols, "t3", { column: "todo" })).toBeNull();
  });

  it("moves with Alt+arrows: within its column, then to the end of the next", () => {
    expect(nudge(cols, "t2", "up")).toEqual({ state: "todo", after: "t1" });
    expect(nudge(cols, "t2", "down")).toEqual({ state: "todo", before: "t3" });
    expect(nudge(cols, "t1", "up")).toBeNull();
    expect(nudge(cols, "t3", "down")).toBeNull();
    expect(nudge(cols, "t2", "right")).toEqual({ state: "doing", before: "t4" });
    expect(nudge(cols, "t2", "left")).toEqual({ state: "backlog" });
    expect(nudge(cols, "t4", "right")).toEqual({ state: "review" });
    expect(nudge(columns([ticket(9, { state: "done" })], everything), "t9", "right")).toBeNull();
  });

  it("takes a rank between its neighbours, as the hub does, and none where there's no room", () => {
    expect(rankBetween(null, null)).toBe(1024);
    expect(rankBetween(1024, null)).toBe(2048);
    expect(rankBetween(null, 1024)).toBe(0);
    expect(rankBetween(1024, 2048)).toBe(1536);
    expect(rankBetween(1, 1 + Number.EPSILON)).toBeNull();
  });

  it("is shown at once: in its new column, between its neighbours", () => {
    const t = ticket(1, { state: "todo" });
    const board = all(t, ticket(2, { state: "doing", rank: 1000 }), ticket(3, { state: "doing", rank: 2000 }));
    const between = moved(t, { state: "doing", before: "t2", after: "t3" }, board, "2026-11-05T12:00:00Z");
    expect(between).toMatchObject({ state: "doing", rank: 1500, stateAt: "2026-11-05T12:00:00Z" });
    expect(moved(t, { state: "doing" }, board, "x").rank).toBe(2000 + 1024);
    expect(moved(t, { state: "todo", after: "t2" }, board, "x").stateAt).toBe(t.stateAt);
  });
});

describe("a ticket's history", () => {
  it("calls the ticket it, and quotes a session's note in its own words", () => {
    expect(historyLine({ kind: "ticket_created", text: "created ACM-12 “Hash every partner key”" }, "ACM-12")).toEqual({ text: "created it", quote: null });
    expect(historyLine({ kind: "ticket_moved", text: "moved ACM-12 to Doing" }, "ACM-12").text).toBe("moved it to Doing");
    expect(historyLine({ kind: "ticket_edited", text: "made ACM-12 need ACM-10" }, "ACM-12").text).toBe("made it need ACM-10");
    expect(historyLine({ kind: "ticket_commented", text: "commented on ACM-12: “clipped…”", detail: { comment: "Both gateways already hash." } }, "ACM-12")).toEqual({
      text: "noted",
      quote: "Both gateways already hash.",
    });
    expect(historyLine({ kind: "ticket_commented", text: "commented on ACM-12: “checking keys”" }, "ACM-12").quote).toBe("checking keys");
  });

  it("sums what its sessions spent on it, and only on it", () => {
    const row = (ticketId: string | null, usd: number | null): LedgerRow => ({
      session: "s-web",
      key: `${ticketId}-${usd}`,
      at: "2026-11-05T10:00:00Z",
      engine: "claude",
      model: "m",
      tokens: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0, reasoning: 10 },
      usd,
      priced: "priced",
      billing: "plan",
      account: null,
      ticket: ticketId,
    });
    expect(spendOf([row("t12", 1.5), row("t12", null), row("t9", 4), row(null, 2)], "t12")).toEqual({ tokens: 2300, usd: 1.5, calls: 2 });
    expect(sessionsOf({ assignee: WEB, links: [{ kind: "session", session: API.id }, { kind: "session", session: WEB.id }, { kind: "pr", number: 4, url: "" }] })).toEqual([WEB.id, API.id]);
  });
});

describe("keys in text", () => {
  it("are the keys of tickets there are, nothing like them", () => {
    expect(keyParts("Take ACM-12 after ACM-9, not XYZ-1 or acm-12.", new Set(["ACM-12", "ACM-9"]))).toEqual([
      { kind: "text", text: "Take " },
      { kind: "key", key: "ACM-12" },
      { kind: "text", text: " after " },
      { kind: "key", key: "ACM-9" },
      { kind: "text", text: ", not XYZ-1 or acm-12." },
    ]);
    expect(keyParts("ACM-120", new Set(["ACM-12"]))).toEqual([{ kind: "text", text: "ACM-120" }]);
  });
});
