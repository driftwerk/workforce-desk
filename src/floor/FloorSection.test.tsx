import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useCharges } from "../crew/chargeStore";
import { useHubLayout } from "../groups/hubLayout";
import type { Layout } from "../groups/model";
import { useDesk } from "../hub/store";
import type { BossView, ChargeView, Need, PlanProgress, Session, Work } from "../hub/types";
import { useSettings } from "../settings/store";
import { FloorSection, PlanProgressCard, useFolded } from "./FloorSection";
import type { FloorNeed, FloorWork } from "./merge";
import { NeedsJump } from "./NeedsJump";
import { MAIN, floorSections, sealedSection, sectionDomId, type Section } from "./sections";
import { NOW, agent, approval, at, need, session, work } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emitTo: vi.fn(() => Promise.resolve()) }));

const layout: Layout = {
  groups: [
    { id: "acme", name: "Acme", collapsed: false, items: ["session:s-web", "session:s-api"] },
    { id: "personal", name: "Personal", collapsed: false, items: ["session:s-dot"] },
    { id: "globex", name: "Globex", collapsed: false, items: [] },
    { id: "old", name: "Old work", collapsed: false, items: ["session:s-old"] },
  ],
  ungrouped: { collapsed: false, items: [] },
};

const SARAH: BossView = {
  scope: { kind: "group", group: "acme" },
  agent: "sarah",
  name: "Sarah",
  level: "act",
  state: "working",
  spend: {
    budget: "b1",
    period: "day",
    unit: "usd",
    used: 18.2,
    of: 40,
    status: "under",
    onExceed: "warn",
    from: at(600),
    to: at(-600),
  } as BossView["spend"],
};
const MIA: BossView = { scope: { kind: "group", group: "globex" }, agent: "mia", name: "Mia", level: "suggest", state: "idle", paused: "over her day budget" };
const DESK: BossView = { scope: { kind: "ungrouped" }, agent: "desk", name: "Desk", level: "act", state: "idle" };

const local = <T extends Need | Work>(item: T, key: string) => ({ ...item, hubId: "local", local: true, key, stale: false });
const fn = (n: Need): FloorNeed => local(n, `local/${n.id}`);
const fw = (w: Work): FloorWork => local(w, `local/${w.who.id}@${w.since}`);

const checkout: PlanProgress = {
  id: "p1",
  goal: "Checkout v2",
  group: "acme",
  boss: "sarah",
  bossName: "Sarah",
  state: "running",
  progress: { done: 3, doing: 3, review: 0, ready: 1, blocked: 1, waiting: 0, total: 8, next: ["ACM-16"] },
};

const built = (): Section[] => {
  const out = floorSections(
    {
      needs: [
        fn(approval("ap1", "s-web", { ask: "Run git push --force?", why: "Sarah can’t answer this one: it rewrites history.", group: "acme", boss: "sarah", since: at(40) })),
        fn(need("q-dot", session("s-dot", "dotfiles"), { ask: "Remove the old backup folder?", group: "personal", since: at(20) })),
        fn(need("q-old", session("s-old", "old-site"), { ask: "Which branch?", group: "old", since: at(5) })),
      ],
      working: [
        fw(work(session("s-web", "acme-web"), { group: "acme", boss: "sarah", gist: { purpose: null, now: "Rebasing onto main.", at: at(1) } })),
        fw(work(session("s-api", "acme-api"), { group: "acme", boss: "sarah", since: at(12) })),
        fw(work(session("s-dot", "dotfiles"), { group: "personal" })),
      ],
      done: [fw(work(session("s-api", "acme-api"), { group: "acme", since: at(90), endedAt: at(60), outcome: "finished" }))],
    },
    { bosses: [DESK, SARAH, MIA], sealed: ["old"], plans: [checkout] },
    layout,
  );
  if (out.kind !== "sections") throw new Error("flat");
  return out.sections;
};

const of = (id: string) => built().find((s) => s.id === id)!;

const charge = (session: string): ChargeView => ({
  session,
  group: "acme",
  boss: "sarah",
  bossName: "Sarah",
  how: "started",
  wheel: "boss",
  wheelSince: null,
  since: at(30),
  releasedAt: null,
});

const live = (id: string): Session => ({ id, name: id, engine: "claude", state: "working", live: true, origin: "desk", cwd: "/work" }) as Session;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  useSettings.setState({ loaded: true, groups: [], sessionNames: {} });
  useFolded.setState({ folded: {} });
  useCharges.setState({ bySession: { "s-web": charge("s-web") } });
  useDesk.setState({ sessions: { "s-web": live("s-web"), "s-api": live("s-api"), "s-dot": live("s-dot") }, restore: [], rooms: {} });
  // After the hub: a new hub starts from Desk's own layout until its snapshot.
  useHubLayout.setState({ layout, kept: true });
  useChat.setState({
    panelAgent: null,
    hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }],
    roster: [
      { hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: true },
      { hubId: "local", id: "sarah", name: "Sarah", model: null, provider: null, isDefault: false },
      { hubId: "local", id: "mia", name: "Mia", model: null, provider: null, isDefault: false },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useHubLayout.setState({ layout: null, kept: null });
});

describe("a group's section", () => {
  it("heads with the group, who runs it, how and how far its budget has gone, and messages its boss", () => {
    render(<FloorSection section={of("acme")} now={NOW} />);
    const sec = screen.getByRole("region", { name: "Acme" });
    expect(within(sec).getByRole("heading", { level: 2 }).textContent).toBe("Acme");
    expect(within(sec).getByText(/^Sarah runs it/).textContent).toBe("Sarah runs it · working · Act · $18.20 of $40 today · 45%");
    fireEvent.click(within(sec).getByRole("button", { name: "Message Sarah" }));
    expect(useChat.getState().panelAgent).toBe("local/sarah");
  });

  it("says why each need reached you, shows its plan's progress, and marks whose each working session is", () => {
    render(<FloorSection section={of("acme")} now={NOW} />);
    const sec = screen.getByRole("region", { name: "Acme" });
    const needs = within(sec).getByRole("group", { name: "Needs you · 1" });
    expect(within(needs).getByText("Sarah can’t answer this one: it rewrites history.")).toBeTruthy();
    expect(within(needs).getByRole("button", { name: /^Allow “Run git push --force\?”/ })).toBeTruthy();
    const plan = within(sec).getByRole("group", { name: "Plan: Checkout v2" });
    expect(plan.textContent).toContain("3 of 8 done · 3 running · next ACM-16");
    expect(within(plan).getByRole("img").getAttribute("aria-label")).toBe("3 done, 3 doing, 1 ready, 1 blocked");
    const web = within(sec).getByRole("article", { name: "acme-web" });
    expect(within(web).getByText("Sarah’s")).toBeTruthy();
    expect(within(web).getByText("Rebasing onto main.")).toBeTruthy();
    expect(within(web).getByText("Claude Code")).toBeTruthy();
    expect(within(within(sec).getByRole("article", { name: "acme-api" })).getByText("yours")).toBeTruthy();
    fireEvent.click(within(sec).getByRole("button", { name: "Done today · 1" }));
    expect(within(sec).getAllByText("acme-api").length).toBeGreaterThan(1);
  });

  it("keeps its needs in view when collapsed, and nothing else", () => {
    render(<FloorSection section={of("acme")} now={NOW} />);
    const sec = screen.getByRole("region", { name: "Acme" });
    fireEvent.click(within(sec).getByRole("button", { name: "Collapse Acme" }));
    expect(within(sec).getByRole("button", { name: "Expand Acme" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(sec).getByRole("group", { name: "Needs you · 1" })).toBeTruthy();
    expect(within(sec).queryByRole("group", { name: "Plan: Checkout v2" })).toBeNull();
    expect(within(sec).queryByRole("article")).toBeNull();
    expect(within(sec).queryByText(/Done today/)).toBeNull();
    fireEvent.click(within(sec).getByRole("button", { name: "Expand Acme" }));
    expect(within(sec).getAllByRole("article")).toHaveLength(2);
  });

  it("says when its boss is held, and has no needs list with none", () => {
    render(<FloorSection section={of("globex")} now={NOW} />);
    const sec = screen.getByRole("region", { name: "Globex" });
    expect(within(sec).getByText(/^Mia runs it/).textContent).toBe("Mia runs it · paused · over her day budget · Suggest");
    expect(within(sec).queryByRole("group", { name: /^Needs you/ })).toBeNull();
    expect(within(sec).getByText("Nothing here needs you, and nothing is running.")).toBeTruthy();
  });
});

describe("the main boss's section", () => {
  it("is everything else, run by the main boss, and its grouped items keep their group's chip", () => {
    render(<FloorSection section={of(MAIN)} now={NOW} />);
    const sec = screen.getByRole("region", { name: "Everything else, Desk runs it" });
    expect(within(sec).getByText(/^Desk runs it/).textContent).toBe("Desk runs it · idle · Act · ungrouped, and Personal (no boss of its own)");
    expect(within(sec).getByRole("button", { name: "Message Desk" })).toBeTruthy();
    const need = within(sec).getByRole("listitem");
    expect(within(need).getByTitle("In Personal")).toBeTruthy();
    expect(within(within(sec).getByRole("article", { name: "dotfiles" })).getByTitle("In Personal")).toBeTruthy();
  });
});

describe("a sealed group's section", () => {
  it("says no one oversees it, and offers no one to message", () => {
    render(<FloorSection section={of(sealedSection("old"))} now={NOW} />);
    const sec = screen.getByRole("region", { name: "Old work" });
    expect(within(sec).getByText("No one oversees it now · what it asks comes to you")).toBeTruthy();
    expect(within(sec).queryByRole("button", { name: /^Message/ })).toBeNull();
    expect(within(sec).getByRole("group", { name: "Needs you · 1" })).toBeTruthy();
  });
});

describe("a plan's progress", () => {
  it("says a proposed plan waits for you, and why a paused one is paused", () => {
    const { rerender } = render(<PlanProgressCard plan={{ ...checkout, state: "proposed" }} />);
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    rerender(<PlanProgressCard plan={{ ...checkout, state: "paused", pausedWhy: "budget" }} />);
    expect(screen.getByRole("group", { name: "Plan: Checkout v2" }).textContent).toContain("3 of 8 done · 3 running · paused: budget");
    expect(screen.queryByText("ACM-16")).toBeNull();
  });
});

describe("the jump bar", () => {
  it("lists each section's needs in the sections' order, and takes the Floor to one", () => {
    const sections = built();
    expect(sections.map((s) => s.id)).toEqual(["acme", MAIN, sealedSection("old"), "globex"]);
    render(
      <>
        <NeedsJump sections={sections} />
        {sections.map((s) => (
          <FloorSection key={s.id} section={s} now={NOW} />
        ))}
      </>,
    );
    const bar = screen.getByRole("navigation", { name: "Needs you, by group" });
    expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual(["Acme 1", "Desk 1", "Old work 1"]);
    const target = document.getElementById(sectionDomId(MAIN))!;
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    fireEvent.click(within(bar).getByRole("button", { name: "Desk: 1 needs you" }));
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    // The total is the sections' sum.
    expect(sections.reduce((n, s) => n + s.needs.length, 0)).toBe(3);
  });

  it("is not there when nothing needs you", () => {
    const { container } = render(<NeedsJump sections={built().map((s) => ({ ...s, needs: [] }))} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("other hubs on a section", () => {
  it("shows an agent of another hub working in the group the sidebar has it in", () => {
    const out = floorSections(
      { needs: [], working: [{ ...work(agent("scout", "Scout"), { group: "globex" }), hubId: "b", local: false, key: "b/scout", stale: false }], done: [] },
      { bosses: [DESK, SARAH], sealed: [], plans: [] },
      { ...layout, groups: layout.groups.map((g) => (g.id === "acme" ? { ...g, items: [...g.items, "agent:b/scout"] } : g)) },
    );
    if (out.kind !== "sections") throw new Error("flat");
    useChat.setState((s) => ({ roster: [...s.roster, { hubId: "b", id: "scout", name: "Scout", model: null, provider: null, isDefault: false }] }));
    render(<FloorSection section={out.sections.find((s) => s.id === "acme")!} now={NOW} />);
    const tile = screen.getByRole("article", { name: "Scout" });
    // An agent has no engine chip and is no one's charge.
    expect(within(tile).queryByText("yours")).toBeNull();
  });
});
