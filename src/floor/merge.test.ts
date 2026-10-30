import { describe, expect, it } from "vitest";
import { merged } from "./merge";
import { agent, approval, at, hub, need, ready, session, view, work } from "./testing";

describe("every hub's floor as one", () => {
  const local = hub("local");
  const remote = hub("b");

  it("tags each item with its hub, keys it across hubs and sorts each column", () => {
    const m = merged(
      {
        local: ready(
          view({
            needs: [approval("ap-1", "s-1", { since: at(5) })],
            working: [work(session("s-1"), { since: at(50) })],
            done: [work(agent("scout"), { endedAt: at(30), outcome: "finished" })],
            counts: { working: 1, needsYou: 1, doneToday: 1 },
          }),
        ),
        b: ready(
          view({
            needs: [need("q-1", agent("scout"), { since: at(20) })],
            working: [work(agent("scout"), { since: at(10) })],
            done: [work(agent("ledger"), { endedAt: at(5), outcome: "failed" })],
            counts: { working: 1, needsYou: 1, doneToday: 3 },
            more: { done: 2, lanes: 1 },
          }),
        ),
      },
      [local, remote],
    );
    expect(m.needs.map((n) => n.key)).toEqual(["b/q-1", "local/ap-1"]);
    expect(m.working.map((w) => w.hubId)).toEqual(["b", "local"]);
    expect(m.done.map((w) => w.who.id)).toEqual(["ledger", "scout"]);
    expect(m.counts).toEqual({ working: 2, needsYou: 2, doneToday: 4 });
    expect(m.more).toEqual({ done: 2, lanes: 1 });
  });

  it("shows a hub's times in this computer's clock", () => {
    const m = merged(
      {
        b: ready(
          view({
            needs: [need("q", agent("a"), { since: at(10) })],
            lanes: [{ who: agent("a"), spans: [{ kind: "working", from: at(30), to: null }] }],
          }),
          { offset: 120_000 },
        ),
      },
      [remote],
    );
    expect(m.needs[0]!.since).toBe(at(12));
    expect(m.lanes[0]!.spans[0]).toEqual({ kind: "working", from: at(32), to: null });
    const said = merged(
      {
        b: ready(view({ working: [work(agent("a"), { gist: { purpose: null, now: "Testing.", at: at(4) } })], summary: { text: "All well.", at: at(6) } }), {
          offset: 120_000,
        }),
      },
      [remote],
    );
    expect(said.working[0]!.gist).toEqual({ purpose: null, now: "Testing.", at: at(6) });
    expect(said.summaries).toEqual([{ text: "All well.", at: at(8), hubId: "b", local: false }]);
  });

  it("keeps a stale hub's items, marked, and leaves out hubs with none", () => {
    const m = merged(
      {
        local: { ...ready(view()), state: "unsupported", floor: null },
        b: ready(view({ needs: [need("q", agent("a"))], counts: { working: 0, needsYou: 1, doneToday: 0 } }), { stale: true }),
        gone: ready(view({ needs: [need("x", agent("z"))] })),
      },
      [local, remote],
    );
    expect(m.needs.map((n) => [n.key, n.stale])).toEqual([["b/q", true]]);
    expect(m.counts.needsYou).toBe(1);
  });
});
