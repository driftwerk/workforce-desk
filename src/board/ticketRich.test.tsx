// The rich ticket view's own reckoning: its layout by width, its PRs merged
// by address, one timeline of comments and history with its filters and
// counts, and the facts it shows and in which order.

import { describe, expect, it } from "vitest";
import type { ActivityEvent, HistoryEvent, TicketComment, TicketDev } from "../hub/types";
import { counts, eventParts, factOrder, filtered, layoutOf, prRows, remoteStateWord, timeline, type EventWords, type FactId } from "./ticketRich";
import { ticket, YOU } from "./testing";

const comment = (id: string, at: string, over: Partial<TicketComment> = {}): TicketComment => ({
  id,
  author: { kind: "person", name: "Dana Kim", on: "Jira" },
  body: "Hi",
  flagged: false,
  at,
  onlyHere: false,
  ...over,
});

const moved = (id: string, at: string): ActivityEvent => ({ id, at, kind: "ticket_moved", actor: YOU, text: "moved ACM-1 to Doing", ticket: "t1" }) as ActivityEvent;

const state = (at: string, by: HistoryEvent["by"], to: string): HistoryEvent => ({ at, by, kind: "state", from: "To Do", to, actor: by === "remote" ? "Dana Kim" : undefined });

const words: EventWords = { system: "jira", me: "Sam", ticketKey: "ACM-1", actorName: () => "You", deskLine: () => "moved it to Doing" };

const text = (parts: ReturnType<typeof eventParts>) => parts.map((p) => ("text" in p ? p.text : "")).join("");

describe("the view's layout", () => {
  it("is two columns when wide or not yet measured, stacked under 760px, and as short as it goes under 600px", () => {
    expect(layoutOf(0)).toBe("wide");
    expect(layoutOf(1440)).toBe("wide");
    expect(layoutOf(760)).toBe("wide");
    expect(layoutOf(759)).toBe("stacked");
    expect(layoutOf(600)).toBe("stacked");
    expect(layoutOf(560)).toBe("compact");
  });
});

describe("a ticket's PRs", () => {
  const dev: TicketDev = {
    prs: [
      { number: 5897, url: "https://github.com/acme/web/pull/5897", title: "Scheduler", state: "open", checks: { passed: 14, total: 14, state: "pass" } },
      { number: 5850, url: "https://github.com/acme/web/pull/5850", title: "Fields", state: "merged", author: "Sam" },
    ],
    branches: [],
    links: [],
    readAt: "2026-11-07T09:00:00Z",
  };

  it("are its issue's, merged by address with a Desk session's link to the same one, then Desk's own", () => {
    const t = ticket(1, {
      links: [
        { kind: "pr", number: 5897, url: "HTTPS://github.com/acme/web/pull/5897/" },
        { kind: "pr", number: 12, url: "https://github.com/acme/web/pull/12" },
        { kind: "pr", number: 12, url: "https://github.com/acme/web/pull/12" },
      ],
    });
    const rows = prRows(t, dev);
    expect(rows.map((r) => [r.number, r.ours])).toEqual([
      [5897, true],
      [5850, false],
      [12, true],
    ]);
    expect(rows[0]!.checks?.passed).toBe(14);
  });

  it("are Desk's alone on a ticket with no development there, and never one at no https address", () => {
    const t = ticket(2, { links: [{ kind: "pr", number: 1, url: "https://example.test/pr/1" }, { kind: "pr", number: 2, url: "javascript:alert(1)" }] });
    expect(prRows(t, undefined).map((r) => r.number)).toEqual([1]);
  });
});

describe("a ticket's activity", () => {
  it("is one timeline by time, Linear's replies under their comment", () => {
    const rows = timeline(
      [comment("c1", "2026-11-02T10:00:00Z"), comment("r1", "2026-11-02T11:00:00Z", { parent: "c1" }), comment("c2", "2026-11-04T10:00:00Z")],
      [],
      [{ at: "2026-11-01T09:00:00Z", by: "remote", kind: "created", actor: "Dana Kim" }],
    );
    expect(rows.map((r) => r.kind)).toEqual(["remote", "comment", "comment"]);
    const first = rows[1]!;
    expect(first.kind === "comment" && first.replies.map((c) => c.id)).toEqual(["r1"]);
  });

  it("makes Desk's move and the change of state it made there one row, Desk's leading", () => {
    const rows = timeline([], [moved("e1", "2026-10-30T10:00:00Z")], [state("2026-10-30T10:00:20Z", "desk", "In Progress")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("desk");
    expect(text(eventParts(rows[0] as never, words))).toBe("You moved it to Doing, In Progress on Jira");
  });

  it("makes a change there and Desk's move that followed it one row, the change there leading", () => {
    const rows = timeline([], [moved("e1", "2026-10-30T10:05:00Z")], [state("2026-10-30T10:00:00Z", "remote", "In Progress")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("remote");
    expect(text(eventParts(rows[0] as never, words))).toContain("Desk moved it to Doing");
  });

  it("keeps a move and a change there apart when they're more than ten minutes apart", () => {
    const rows = timeline([], [moved("e1", "2026-10-30T10:11:00Z")], [state("2026-10-30T10:00:00Z", "remote", "In Progress")]);
    expect(rows.map((r) => r.kind)).toEqual(["remote", "desk"]);
  });

  it("filters to comments, history or what stayed in Desk, and counts each", () => {
    const rows = timeline(
      [comment("c1", "2026-11-02T10:00:00Z"), comment("r1", "2026-11-02T11:00:00Z", { parent: "c1" }), comment("c2", "2026-11-03T10:00:00Z", { onlyHere: true, author: { kind: "agent", name: "acme-web", on: "Desk" } })],
      [moved("e1", "2026-10-30T10:00:00Z")],
      [state("2026-10-30T10:00:20Z", "desk", "In Progress"), { at: "2026-11-01T09:00:00Z", by: "github", kind: "field", field: "#5850", to: "merged" }],
    );
    expect(filtered(rows, "all")).toHaveLength(4);
    expect(filtered(rows, "comments").map((r) => r.kind)).toEqual(["comment", "comment"]);
    expect(filtered(rows, "history").map((r) => r.kind)).toEqual(["desk", "remote"]);
    expect(filtered(rows, "desk")).toHaveLength(1);
    // Comments count their replies; history counts a joined pair once.
    expect(counts(rows)).toEqual({ comments: 3, history: 2, desk: 1 });
  });
});

describe("a ticket's facts", () => {
  const has = (...ids: FactId[]) => (f: FactId) => ids.includes(f);

  it("are in each system's order, and the band shows its first eight", () => {
    const every = () => true;
    expect(factOrder("jira", has("due", "state", "type", "reporter"))).toEqual(["type", "state", "reporter", "due"]);
    expect(factOrder("linear", has("created", "state", "priority"))).toEqual(["state", "priority", "created"]);
    expect(factOrder(null, has("assignee", "state"))).toEqual(["state", "assignee"]);
    expect(factOrder("jira", every, true)).toEqual(["state", "working", "assignee", "priority", "type", "points", "sprint", "due"]);
    expect(factOrder("linear", every, true)).toHaveLength(8);
  });

  it("say what its issue calls its state only where it differs from Desk's column", () => {
    expect(remoteStateWord("doing", "In Progress")).toBe("In Progress");
    expect(remoteStateWord("doing", "doing")).toBeNull();
    expect(remoteStateWord("done", "Done")).toBeNull();
    expect(remoteStateWord("doing", undefined)).toBeNull();
  });
});
