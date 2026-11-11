import { describe, expect, it } from "vitest";
import type { DeskGroup } from "../groups/model";
import { merged } from "./merge";
import { groupOfFloorItem, scoped } from "./scope";
import { agent, at, hub, need, ready, session, view, work } from "./testing";

const groups: DeskGroup[] = [
  { id: "platform", name: "Platform", collapsed: false, items: ["session:s-web", "agent:b/scout", "session:devbox/m1"] },
  { id: "docs", name: "Docs", collapsed: false, items: ["session:s-docs"] },
];

describe("one group's Floor", () => {
  it("places this computer's items by the group its hub stamped, everything else by the sidebar", () => {
    const local = { hubId: "local", local: true };
    expect(groupOfFloorItem(groups, { ...local, who: session("s-web"), group: "platform" })).toBe("platform");
    // Stamped ungrouped: so it is, whatever the sidebar says now.
    expect(groupOfFloorItem(groups, { ...local, who: session("s-web"), group: null })).toBeNull();
    // Not stamped at all (Today's lanes): by the sidebar.
    expect(groupOfFloorItem(groups, { ...local, who: session("s-docs") })).toBe("docs");
    expect(groupOfFloorItem(groups, { hubId: "b", local: false, who: agent("scout"), group: "docs" })).toBe("platform");
    expect(groupOfFloorItem(groups, { hubId: "devbox", local: false, machine: "devbox", who: session("m1") })).toBe("platform");
  });

  it("keeps the group's needs, work, done and lanes, and counts them", () => {
    const day = Date.parse(at(120));
    const m = merged(
      {
        local: ready(
          view({
            needs: [need("n1", session("s-web"), { group: "platform" }), need("n2", session("s-docs"), { group: "docs" })],
            working: [work(session("s-web"), { group: "platform" }), work(session("s-docs"), { group: "docs" })],
            done: [
              work(session("s-web"), { group: "platform", endedAt: at(30) }),
              // Yesterday's: not done today.
              work(session("s-web"), { group: "platform", endedAt: at(600) }),
            ],
            lanes: [{ who: session("s-docs"), spans: [] }],
            counts: { working: 2, needsYou: 2, doneToday: 2 },
          }),
        ),
      },
      [hub("local")],
    );
    const p = scoped(m, "platform", groups, day);
    expect(p.needs.map((n) => n.id)).toEqual(["n1"]);
    expect(p.working.map((w) => w.who.id)).toEqual(["s-web"]);
    expect(p.done).toHaveLength(2);
    expect(p.lanes).toEqual([]);
    expect(p.counts).toEqual({ working: 1, needsYou: 1, doneToday: 1 });
    expect(scoped(m, "docs", groups, day).lanes.map((l) => l.who.id)).toEqual(["s-docs"]);
    expect(p.summaries).toEqual([]);
  });
});
