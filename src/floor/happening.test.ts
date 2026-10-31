import { describe, expect, it } from "vitest";
import { DONE_FOR_MS, happening } from "./happening";
import { merged, type FloorWork } from "./merge";
import { NOW, agent, at, hub, ready, session, view, work } from "./testing";

const on = (id: string, over: Parameters<typeof view>[0], offset = 0) =>
  merged({ [id]: ready(view(over), { offset }) }, [hub(id)]);

describe("what's happening", () => {
  it("is one entry per agent or session: working, then waiting, then done, latest first", () => {
    const m = on("local", {
      working: [
        work(agent("scout", "Scout"), { since: at(30), heardAt: at(9) }),
        work(agent("scout", "Scout"), { since: at(10), heardAt: at(2), background: { count: 1, since: at(3) } }),
        work(session("s-1", "repo"), { since: at(5), heardAt: at(4), background: { count: 2, since: at(4) } }),
      ],
      done: [
        work(agent("scout", "Scout"), { endedAt: at(1), outcome: "finished" }),
        work(agent("lens", "Lens"), { endedAt: at(40), outcome: "failed" }),
        work(agent("lens", "Lens"), { endedAt: at(20), outcome: "finished" }),
        work(agent("atlas", "Atlas"), { endedAt: at(30), outcome: "limit" }),
      ],
    });
    const entries = happening(m, NOW);
    expect(entries.map((e) => [e.who.id, e.state])).toEqual([
      ["scout", "working"],
      ["s-1", "waiting"],
      ["lens", "done"],
      ["atlas", "failed"],
    ]);
    expect(entries[0]!.at).toBe(at(9));
    expect(entries.map((e) => e.key)).toEqual(["local/agent:scout", "local/session:s-1", "local/agent:lens", "local/agent:atlas"]);
  });

  it("folds a session an agent's turn ran as into that agent's entry", () => {
    const m = on("local", {
      working: [
        work(session("s-9", "at-dm-d4774cbb6c89-2e"), { since: at(2), heardAt: at(1) }),
        work(agent("scout", "Scout"), { since: at(3), gist: { purpose: "Watching the spend.", now: "Comparing this month.", at: at(2) } }),
      ],
      done: [work(agent("scout", "Scout"), { endedAt: at(20), outcome: "finished" })],
    });
    const whoOf = (w: FloorWork) => (w.who.id === "s-9" ? agent("scout", "Scout") : w.who);
    const entries = happening(m, NOW, whoOf);
    expect(entries.map((e) => [e.key, e.state, e.who.name, e.now])).toEqual([["local/agent:scout", "working", "Scout", "Comparing this month."]]);
  });

  it("keeps what finished within two hours and drops what finished before", () => {
    const m = on("local", {
      done: [
        work(agent("lens"), { endedAt: new Date(NOW - DONE_FOR_MS).toISOString(), outcome: "finished" }),
        work(agent("old"), { endedAt: new Date(NOW - DONE_FOR_MS - 60_000).toISOString(), outcome: "finished" }),
      ],
    });
    expect(happening(m, NOW).map((e) => e.who.id)).toEqual(["lens"]);
  });

  it("says the hub's gist, in this computer's time, and plainly without one", () => {
    const m = on(
      "b",
      {
        working: [work(agent("scout"), { gist: { purpose: "Shipping the release.", now: "Testing it.", at: at(5) } })],
        done: [work(agent("lens"), { what: "Merged PR #5 into main.", endedAt: at(3), outcome: "finished" })],
      },
      120_000,
    );
    const [scout, lens] = happening(m, NOW);
    expect(scout).toMatchObject({ purpose: "Shipping the release.", now: "Testing it.", at: at(7) });
    expect(lens).toMatchObject({ purpose: null, now: "Finished 5 min ago.", at: at(5) });
  });

  it("says, without a gist, only what Desk knows: never what the turn was asked", () => {
    const m = on("local", {
      working: [
        work(session("s-1", "acme-web"), { what: "classify is off - merge it", since: at(3) }),
        work(session("s-2", "at-dm-d4774cbb6c89-2e"), { what: "classify is off - merge it", since: at(4) }),
        work(agent("scout", "Scout"), { what: "classify is off - merge it", since: at(5) }),
        work(session("s-3", "repo"), { what: "classify is off - merge it", since: at(6), background: { count: 2, since: at(2) } }),
      ],
      done: [
        work(agent("lens", "Lens"), { what: "classify is off - merge it", endedAt: at(12), outcome: "finished" }),
        work(agent("ops", "Ops"), { what: "classify is off - merge it", endedAt: at(0), outcome: "finished" }),
        work(agent("atlas", "Atlas"), { what: "classify is off - merge it", endedAt: at(75), outcome: "failed" }),
        work(agent("desk", "Desk"), { what: "classify is off - merge it", endedAt: at(30), outcome: "limit" }),
      ],
    });
    const said = Object.fromEntries(happening(m, NOW).map((e) => [e.who.id, e.now]));
    expect(said).toEqual({
      "s-1": "Working on acme-web.",
      "s-2": "Working on it now.",
      scout: "Working on it now.",
      "s-3": "Waiting on 2 background tasks.",
      lens: "Finished 12 min ago.",
      ops: "Finished just now.",
      atlas: "Stopped with an error 1h 15m ago.",
      desk: "Stopped at its plan’s limit 30 min ago.",
    });
    const named = happening(m, NOW, (w) => w.who, ({ who }) => (who.id === "s-2" ? "workforce-desk" : null));
    expect(named.find((e) => e.who.id === "s-2")!.now).toBe("Working on workforce-desk.");
  });

  it("has no entry for a turn that is no one's, and an agent's failed turn is that agent's", () => {
    const m = on("local", {
      done: [
        work(session("s-8", "at-dm-0a1b2c3d4e5f-2e"), { endedAt: at(5), outcome: "limit" }),
        work(session("s-9", "at-dm-d4774cbb6c89-2e"), { endedAt: at(10), outcome: "limit" }),
        work(agent("desk", "Desk"), { endedAt: at(40), outcome: "finished" }),
      ],
    });
    const whoOf = (w: FloorWork) => (w.who.id === "s-9" ? agent("desk", "Desk") : w.who.id === "s-8" ? null : w.who);
    expect(happening(m, NOW, whoOf).map((e) => [e.key, e.who.name, e.state, e.now])).toEqual([
      ["local/agent:desk", "Desk", "failed", "Stopped at its plan’s limit 10 min ago."],
    ]);
  });
});
