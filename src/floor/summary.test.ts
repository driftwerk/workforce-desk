import { describe, expect, it } from "vitest";
import type { Merged } from "./merge";
import { sentence } from "./summary";
import { NOW, agent, approval, at, need, session, work } from "./testing";

const day = Date.parse("2026-10-29T00:00:00Z");
const tag = <T>(x: T) => ({ ...x, hubId: "local", key: Math.random().toString(), stale: false });
const m = (over: Partial<Pick<Merged, "needs" | "working" | "done">>): Pick<Merged, "needs" | "working" | "done"> => ({
  needs: [],
  working: [],
  done: [],
  ...over,
});

describe("Desk's own summary", () => {
  it("says when nothing is going on", () => {
    expect(sentence(m({}), day)).toBe("Nothing needs you, and nothing is running.");
  });

  it("says one of each", () => {
    expect(
      sentence(
        m({
          needs: [tag(approval("ap", "s-1", { who: session("s-1", "acme-web"), ask: "Run npm test?" }))],
          working: [tag(work(agent("ledger", "Ledger"), { what: "Comparing spend" }))],
          done: [tag(work(agent("herald", "Herald"), { what: "Labelled 3 issues.", endedAt: at(30), outcome: "finished" }))],
        }),
        day,
      ),
    ).toBe(
      "One thing is waiting on you: acme-web wants to run npm test. Ledger is working on “Comparing spend”. Since this morning: Herald finished “Labelled 3 issues”.",
    );
  });

  it("names three of each at most, uses the person's names for sessions, and says background work", () => {
    const needs = ["a", "b", "c", "d", "e"].map((id) => tag(need(id, agent(id, id.toUpperCase()), { ask: "Which one?" })));
    const text = sentence(
      m({
        needs: [tag(approval("ap", "s-1", { who: session("s-1", "hub-name") })), ...needs],
        working: [tag(work(session("s-2", "repo"), { background: { count: 2, since: at(5) } })), tag(work(agent("l", "Ledger")))],
        done: [tag(work(agent("y", "Old"), { endedAt: new Date(day - 60_000).toISOString(), outcome: "finished" }))],
      }),
      day,
      { "s-1": "my-session" },
    );
    expect(text).toBe(
      "Six things are waiting on you: my-session wants to run npm test; A asks “Which one”; B asks “Which one”; and 3 more. repo is waiting on 2 background tasks; Ledger is running Bash cargo test.",
    );
    expect(NOW).toBeGreaterThan(day);
  });
});
