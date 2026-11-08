import { describe, expect, it } from "vitest";
import type { Layout } from "../groups/model";
import type { BossView, Need, PlanProgress, Work } from "../hub/types";
import type { FloorNeed, FloorWork } from "./merge";
import { MAIN, floorSections, oversightOf, placer, sealedSection, sectionDomId, sectionName, sectionOfEvent, totals, type DeskItem, type Oversight, type Section } from "./sections";
import { agent, approval, at, need, session, view, work } from "./testing";

const layout: Layout = {
  groups: [
    { id: "acme", name: "Acme", collapsed: false, items: ["session:s-web", "agent:local/sarah", "agent:b/scout", "session:devbox/m1"] },
    { id: "personal", name: "Personal", collapsed: false, items: ["session:s-dot"] },
    { id: "globex", name: "Globex", collapsed: false, items: ["session:s-idx", "agent:local/mia"] },
    { id: "old", name: "Old work", collapsed: false, items: ["session:s-old"] },
  ],
  ungrouped: { collapsed: false, items: ["session:s-blog"] },
};

const boss = (agentId: string, name: string, group: string | null, over: Partial<BossView> = {}): BossView => ({
  scope: group ? { kind: "group", group } : { kind: "ungrouped" },
  agent: agentId,
  name,
  level: "act",
  state: "idle",
  ...over,
});

const MAIN_BOSS = boss("desk", "Desk", null);
const SARAH = boss("sarah", "Sarah", "acme", { state: "working" });
const MIA = boss("mia", "Mia", "globex");

const oversight = (over: Partial<Oversight> = {}): Oversight => ({ bosses: [MAIN_BOSS, SARAH, MIA], sealed: ["old"], plans: [], ...over });

type From = { hubId?: string; machine?: string };

/** As the merge tags them: this computer's hub's items are `local`. */
const tagged = <T extends Need | Work>(item: T, { hubId = "local", machine }: From = {}, key = `${hubId}/${item.who.id}`): T & { hubId: string; local: boolean; key: string; stale: boolean; machine?: string } => ({
  ...item,
  hubId,
  local: hubId === "local",
  ...(machine ? { machine } : {}),
  key,
  stale: false,
});

const fn = (n: Need, from?: From): FloorNeed => tagged(n, from, `${from?.hubId ?? "local"}/${n.id}`);
const fw = (w: Work, from?: From): FloorWork => tagged(w, from);

const plan = (id: string, group: string | null, over: Partial<PlanProgress> = {}): PlanProgress => ({
  id,
  goal: `Plan ${id}`,
  group,
  boss: "sarah",
  bossName: "Sarah",
  state: "running",
  progress: { done: 3, doing: 3, review: 0, ready: 1, blocked: 1, waiting: 0, total: 8, next: ["ACM-16"] },
  ...over,
});

const sections = (floor: { needs?: FloorNeed[]; working?: FloorWork[]; done?: FloorWork[] }, over: Partial<Oversight> = {}, l = layout): Section[] => {
  const out = floorSections({ needs: [], working: [], done: [], ...floor }, oversight(over), l);
  if (out.kind !== "sections") throw new Error("flat");
  return out.sections;
};

const byId = (all: Section[], id: string): Section => all.find((s) => s.id === id)!;
const ids = (items: readonly { who: { id: string } }[]) => items.map((i) => i.who.id);

describe("the Floor by group", () => {
  it("is flat with no bossed group, though the hub names the main boss and stamps a group with no boss", () => {
    const floor = { needs: [fn(need("q1", agent("scout"), { group: "personal" }))], working: [fw(work(session("s-dot"), { group: "personal" }))], done: [] };
    expect(floorSections(floor, oversight({ bosses: [MAIN_BOSS], sealed: [] }), layout)).toEqual({ kind: "flat", sealed: [] });
    // Only a sealed group isn't a bossed one either.
    expect(floorSections(floor, oversight({ bosses: [MAIN_BOSS] }), layout)).toEqual({ kind: "flat", sealed: [] });
    // Nor is a boss of a group the sidebar no longer has.
    expect(floorSections(floor, oversight({ bosses: [MAIN_BOSS, boss("zed", "Zed", "gone")] }), layout)).toEqual({ kind: "flat", sealed: [] });
    expect(floorSections(floor, oversightOf(view()), layout)).toEqual({ kind: "flat", sealed: [] });
  });

  it("places this computer's hub's items by its stamp: where they are now, a moved one too", () => {
    const all = sections({
      needs: [
        // The layout Desk holds still says Acme; the hub read it after the move.
        fn(approval("ap1", "s-web", { group: "globex", boss: "mia" })),
        // Sarah sits in no group, but her own turns are Acme's.
        fn(need("q-sarah", agent("sarah", "Sarah"), { group: "acme", boss: "sarah" })),
      ],
      working: [fw(work(session("s-idx"), { group: "globex", boss: "mia" })), fw(work(session("s-blog")))],
    });
    expect(ids(byId(all, "globex").needs)).toEqual(["s-web"]);
    expect(ids(byId(all, "acme").needs)).toEqual(["sarah"]);
    expect(ids(byId(all, "globex").working)).toEqual(["s-idx"]);
    expect(ids(byId(all, MAIN).working)).toEqual(["s-blog"]);
  });

  it("places other hubs' agents and machines' sessions by their key in the sidebar, whatever those hubs stamp", () => {
    const all = sections({
      needs: [
        // Hub b's Scout is in Acme on this sidebar; b says otherwise, and isn't read.
        fn(need("q9", agent("scout", "Scout"), { group: "globex", boss: "mia" }), { hubId: "b" }),
        // A machine's session is `session:devbox/m1`.
        fn(approval("ap2", "m1", { group: "globex" }), { hubId: "devbox-hub", machine: "devbox" }),
        // Another hub's agent the sidebar has in no group is the main boss's.
        fn(need("q8", agent("ada", "Ada"), { group: "acme", boss: "sarah" }), { hubId: "b" }),
      ],
      working: [fw(work(agent("scout", "Scout"), { group: "globex" }), { hubId: "b" })],
    });
    expect(ids(byId(all, "acme").needs)).toEqual(["scout", "m1"]);
    expect(ids(byId(all, "acme").working)).toEqual(["scout"]);
    expect(ids(byId(all, MAIN).needs)).toEqual(["ada"]);
    expect(byId(all, "globex").needs).toEqual([]);
  });

  it("puts a sealed group's items in a section of its own, no one's, never the main boss's", () => {
    const all = sections({
      needs: [fn(need("q-old", session("s-old"), { group: "old" }))],
      done: [fw(work(session("s-old"), { group: "old", endedAt: at(5), outcome: "finished" }))],
    });
    const sealed = byId(all, sealedSection("old"));
    expect(sealed).toMatchObject({ kind: "sealed", group: { id: "old", name: "Old work" }, boss: null });
    expect(ids(sealed.needs)).toEqual(["s-old"]);
    expect(ids(sealed.done)).toEqual(["s-old"]);
    expect(byId(all, MAIN).needs).toEqual([]);
    // With nothing on the floor, it shows no section.
    expect(sections({}).map((s) => s.id)).toEqual(["acme", "globex", MAIN]);
  });

  it("gives the main boss what's ungrouped and what's in a group with no boss, which keeps its chip", () => {
    const dot = fn(need("q-dot", session("s-dot"), { group: "personal" }));
    const blog = fn(need("q-blog", session("s-blog")));
    const main = byId(sections({ needs: [dot, blog] }), MAIN);
    expect(main).toMatchObject({ kind: "main", group: null, boss: MAIN_BOSS, unbossed: [{ id: "personal", name: "Personal" }] });
    expect(ids(main.needs)).toEqual(["s-dot", "s-blog"]);
    expect(main.chips).toEqual({ [dot.key]: "personal" });
    expect(sectionName(main)).toBe("Desk");
    // A hub that names no main boss: it's still there, run by no one.
    expect(byId(sections({}, { bosses: [SARAH] }), MAIN).boss).toBeNull();
    expect(sectionName(byId(sections({}, { bosses: [SARAH] }), MAIN))).toBe("Everything else");
  });

  it("puts each plan in its own group's section", () => {
    const all = sections({}, { plans: [plan("p1", "acme"), plan("p2", null), plan("p3", "old"), plan("p4", "personal"), plan("p5", "globex")] });
    expect(byId(all, "acme").plans.map((p) => p.id)).toEqual(["p1"]);
    expect(byId(all, MAIN).plans.map((p) => p.id)).toEqual(["p2", "p4"]);
    expect(byId(all, sealedSection("old")).plans.map((p) => p.id)).toEqual(["p3"]);
    expect(byId(all, "globex").plans.map((p) => p.id)).toEqual(["p5"]);
  });

  it("orders sections with needs first, the oldest need first, then the sidebar's order with the main boss's last", () => {
    // No needs: sidebar order, main last.
    expect(sections({}).map((s) => s.id)).toEqual(["acme", "globex", MAIN]);
    // Globex's need is the oldest, then main's; Acme has none.
    const all = sections({
      needs: [
        fn(need("q-g", session("s-idx"), { group: "globex", since: at(40) })),
        fn(need("q-m", session("s-blog"), { since: at(30) })),
        fn(need("q-m2", session("s-blog"), { since: at(2) })),
      ],
    });
    expect(all.map((s) => s.id)).toEqual(["globex", MAIN, "acme"]);
    // Each need is in exactly one section: their sum is the header's count.
    expect(all.reduce((n, s) => n + s.needs.length, 0)).toBe(3);
  });

  it("is the same total, need for need, as the floor it was made from", () => {
    const needs = [
      fn(approval("a", "s-web", { group: "acme", boss: "sarah", since: at(50) })),
      fn(need("b", agent("scout"), { group: "globex" }), { hubId: "b" }),
      fn(need("c", session("s-old"), { group: "old" })),
      fn(need("d", session("s-blog"))),
      fn(approval("e", "m1"), { hubId: "devbox-hub", machine: "devbox" }),
    ];
    const all = sections({ needs });
    expect(
      all
        .flatMap((s) => s.needs)
        .map((n) => n.key)
        .sort(),
    ).toEqual(needs.map((n) => n.key).sort());
  });

  it("reads who oversees what from a floor, none from an older hub", () => {
    expect(oversightOf(view())).toEqual({ bosses: [], sealed: [], plans: [] });
    expect(oversightOf(view({ bosses: [SARAH], sealed: ["old"], plans: [plan("p1", "acme")] })).bosses).toEqual([SARAH]);
    expect(oversightOf(null)).toEqual({ bosses: [], sealed: [], plans: [] });
  });

  it("names a sealed section apart from a group's, and as an element's id safely", () => {
    const p = placer(layout, oversight());
    expect(p.ofGroup("old")).toBe(sealedSection("old"));
    expect(p.ofGroup("acme")).toBe("acme");
    expect(p.ofGroup("personal")).toBe(MAIN);
    expect(p.ofGroup(null)).toBe(MAIN);
    expect(sectionDomId("sealed:old")).toMatch(/^floor-section-[A-Za-z0-9_-]+$/);
    expect(sectionDomId("a:b")).not.toBe(sectionDomId("a_b"));
  });
});

describe("done today", () => {
  it("counts only what ended since the day began, though the hubs send the last 24 hours", () => {
    const today = fw(work(session("s-idx"), { group: "globex", since: at(90), endedAt: at(30), outcome: "finished" }));
    const yesterday = fw(work(session("s-web"), { group: "globex", since: at(900), endedAt: at(800), outcome: "finished" }));
    const out = floorSections({ needs: [], working: [], done: [today, yesterday] }, oversight(), layout, { day: Date.parse(at(60)) });
    if (out.kind !== "sections") throw new Error("flat");
    expect(ids(byId(out.sections, "globex").done)).toEqual(["s-idx"]);
  });
});

describe("placing what carries no stamp", () => {
  it("puts this computer's agents and sessions by the sidebar, a boss in the group it oversees", () => {
    const p = placer({ ...layout, ungrouped: { collapsed: false, items: ["agent:local/sarah", "session:s-blog"] }, groups: layout.groups.map((g) => ({ ...g, items: g.items.filter((k) => k !== "agent:local/sarah") })) }, oversight());
    expect(p.ofLocal("local", { kind: "agent", id: "sarah" })).toBe("acme");
    expect(p.ofLocal("local", { kind: "session", id: "s-idx" })).toBe("globex");
    expect(p.ofLocal("local", { kind: "session", id: "s-old" })).toBe(sealedSection("old"));
    expect(p.ofLocal("local", { kind: "session", id: "s-blog" })).toBe(MAIN);
    expect(p.ofLocal("local", { kind: "you", id: "me" })).toBe(MAIN);
    expect(p.ofLocal("local", { kind: "manager", id: "desk" })).toBe(MAIN);
  });
});

const desk = (kind: "agent" | "session", id: string, look: DeskItem["look"]): DeskItem => ({
  key: kind === "session" ? `session:${id}` : `agent:local/${id}`,
  who: { kind, id },
  name: id,
  engine: kind === "session" ? "claude" : null,
  text: null,
  look,
});

describe("Desk's own sessions and agents, with no turn on any hub's floor", () => {
  it("keeps each in its own sidebar section, a blocked one too, and leaves out those the floor has", () => {
    const out = floorSections(
      { needs: [fn(need("q-dot", session("s-dot"), { group: "personal" }))], working: [fw(work(session("s-idx"), { group: "globex", boss: "mia" }))], done: [] },
      oversight(),
      layout,
      {
        localHub: "local",
        desk: [
          desk("session", "s-web", "blocked"),
          desk("session", "s-idx", "working"),
          desk("session", "s-dot", "blocked"),
          desk("session", "s-blog", "working"),
          desk("agent", "mia", "working"),
          desk("session", "s-old", "done"),
        ],
      },
    );
    if (out.kind !== "sections") throw new Error("flat");
    const deskIn = (id: string) => byId(out.sections, id).desk.map((d) => `${d.who.id}:${d.look}`);
    expect(deskIn("acme")).toEqual(["s-web:blocked"]);
    // Mia is in her group, though her row sits elsewhere; s-idx is on the floor already.
    expect(deskIn("globex")).toEqual(["mia:working"]);
    expect(deskIn(MAIN)).toEqual(["s-blog:working"]);
    expect(deskIn(sealedSection("old"))).toEqual(["s-old:done"]);
    // They count where they show: the header's totals are the sections' own.
    expect(totals(out.sections)).toEqual({ working: 4, needsYou: 1, doneToday: 1 });
  });

  it("adds up to the header from the sections' own lists", () => {
    const all = sections({
      needs: [fn(need("a", session("s-web"), { group: "acme" })), fn(need("b", session("s-blog")))],
      working: [fw(work(session("s-web"), { group: "acme" })), fw(work(session("s-idx"), { group: "globex" }))],
      done: [fw(work(session("s-blog"), { since: at(90), endedAt: at(30), outcome: "finished" }))],
    });
    expect(totals(all)).toEqual({ working: 2, needsYou: 2, doneToday: 1 });
  });
});

describe("a sealed group while no group has a boss", () => {
  it("stays flat, and says which items no one oversees", () => {
    const old = fn(need("q-old", session("s-old"), { group: "old" }));
    const out = floorSections({ needs: [old, fn(need("q-blog", session("s-blog")))], working: [], done: [] }, oversight({ bosses: [MAIN_BOSS] }), layout);
    expect(out).toEqual({ kind: "flat", sealed: [{ group: { id: "old", name: "Old work" }, items: [old] }] });
  });
});

describe("the main boss and you in Activity", () => {
  it("are the main boss's section, wherever the main boss's row sits", () => {
    const p = placer({ ...layout, groups: layout.groups.map((g) => (g.id === "acme" ? { ...g, items: [...g.items, "agent:local/desk"] } : g)) }, oversight());
    expect(p.ofLocal("local", { kind: "agent", id: "desk" })).toBe(MAIN);
    expect(p.ofLocal("local", { kind: "manager", id: "desk" })).toBe(MAIN);
    expect(p.ofLocal("local", { kind: "you", id: "sam" })).toBe(MAIN);
  });
});

describe("an Activity event's section", () => {
  const p = placer(layout, oversight());
  const ev = (over: Partial<Parameters<typeof sectionOfEvent>[2]>) => ({ actor: { kind: "session" as const, id: "s-web", name: "acme-web" }, subject: null, ...over });
  it("is the group the hub stamped it with: a moved session's past stays where it happened", () => {
    // s-web sits in Acme now; this happened while it was in Globex.
    expect(sectionOfEvent(p, "local", ev({ group: "globex" }))).toBe("globex");
    expect(sectionOfEvent(p, "local", ev({ group: null }))).toBe(MAIN);
    expect(sectionOfEvent(p, "local", ev({ group: "old" }))).toBe(sealedSection("old"));
  });
  it("is by the sidebar now only from a hub that stamps none, and by its subject alone", () => {
    expect(sectionOfEvent(p, "local", ev({}))).toBe("acme");
    expect(sectionOfEvent(p, "local", ev({ actor: { kind: "manager", id: "desk", name: "Desk" }, subject: { kind: "session", id: "s-idx", name: "i" } }))).toBe("globex");
    expect(sectionOfEvent(p, "local", ev({ actor: { kind: "you", id: "sam", name: "You" } }))).toBe(MAIN);
  });
});
