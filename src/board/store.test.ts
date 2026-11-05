import { describe, expect, it } from "vitest";
import { ticketIndex, ticketOfSession } from "./store";
import { API, WEB, ticket } from "./testing";

describe("the tickets' index", () => {
  it("gives each session its open ticket (given to it before linked to it, newest first) and each key its ticket, worked out once", () => {
    const tickets = {
      t1: ticket(1, { state: "doing", assignee: WEB, updatedAt: "2026-11-05T10:00:00Z" }),
      t2: ticket(2, { state: "review", assignee: WEB, updatedAt: "2026-11-05T11:00:00Z" }),
      t3: ticket(3, { state: "done", assignee: API, updatedAt: "2026-11-05T12:00:00Z" }),
      t4: ticket(4, { state: "todo", links: [{ kind: "session", session: API.id }, { kind: "session", session: WEB.id }] }),
    };
    const index = ticketIndex(tickets);
    expect(index.bySession.get(WEB.id)?.id).toBe("t2");
    expect(index.bySession.get(API.id)?.id).toBe("t4");
    expect(index.byKey.get("ACM-3")?.id).toBe("t3");
    expect(ticketIndex(tickets)).toBe(index);
    expect(ticketOfSession({ ...tickets }, "nobody")).toBeNull();
  });
});
