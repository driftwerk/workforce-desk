import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", async (original) => ({ ...(await original<object>()), saveSettings: vi.fn(() => Promise.resolve()), loadSettings: vi.fn() }));

import type { Layout } from "./model";

const { useDesk, announce: deliver } = await import("../hub/store");
const { useMachines } = await import("../hub/engines");
const { useSettings } = await import("../settings/store");
const { forgetGone, nameSession, useHubLayout, moveItem } = await import("./store");
const { dropAt, dropItems, dropOn, machineOfItem, mergeMachineLayout, moveItem: moved, resolve, sessionItem, UNGROUPED, EMPTY_LAYOUT } = await import("./model");
const { followMachineSessions, goneOn, machineSessions, useMachineSessions } = await import("./machines");

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session = (id: string, more: Record<string, unknown> = {}) => ({ id, name: `hub-${id}`, engine: "claude", state: "idle", updatedAt: "2026-11-06T00:00:00Z", ...more }) as never;
const devbox = (state: string = "ready") => ({ id: "devbox", name: "devbox", target: "devbox", version: null, state: { kind: state } }) as never;

const layoutOf = (): Layout => ({ groups: useSettings.getState().groups, ungrouped: useSettings.getState().ungrouped });

describe("a session's layout item", () => {
  it("is its key on Desk: this computer's as it always was, a machine's with its machine", () => {
    expect(sessionItem(U(1))).toBe(`session:${U(1)}`);
    expect(sessionItem(`devbox/${U(1)}`)).toBe(`session:devbox/${U(1)}`);
    expect(machineOfItem(`session:${U(1)}`)).toBe("local");
    expect(machineOfItem(`session:devbox/${U(1)}`)).toBe("devbox");
    expect(machineOfItem("agent:local/scout")).toBeNull();
  });

  it("a machine's session moves between groups and back to Ungrouped like any other", () => {
    const remote = `session:devbox/${U(1)}`;
    const present = [`session:${U(2)}`, remote];
    const two: Layout = {
      groups: [
        { id: "acme", name: "Acme", collapsed: false, items: [`session:${U(2)}`] },
        { id: "atlas", name: "Atlas", collapsed: false, items: [] },
      ],
      ungrouped: { collapsed: false, items: [] },
    };
    // Not in the layout yet: in Ungrouped, as a session of this computer's would be.
    expect(resolve(two, present).at(-1)!.items).toEqual([remote]);
    const inAcme = moved(two, present, remote, "acme", `session:${U(2)}`);
    expect(inAcme.groups[0]!.items).toEqual([remote, `session:${U(2)}`]);
    const inAtlas = moved(inAcme, present, remote, "atlas", null);
    expect(inAtlas.groups.map((g) => g.items)).toEqual([[`session:${U(2)}`], [remote]]);
    const back = moved(inAtlas, present, remote, UNGROUPED, null);
    expect(resolve(back, present).at(-1)!.items).toEqual([remote]);
  });

  it("a machine's session dragged from Ungrouped onto another group's row, then onto a group's header, lands there", () => {
    const remote = `session:devbox/${U(1)}`;
    const present = [`session:${U(2)}`, "agent:local/allan", remote];
    const l: Layout = {
      groups: [
        { id: "acme", name: "Acme", collapsed: false, items: [`session:${U(2)}`] },
        { id: "atlas", name: "Atlas", collapsed: false, items: ["agent:local/allan"] },
      ],
      ungrouped: { collapsed: false, items: [] },
    };
    const onAllan = dropAt(l, resolve(l, present), { type: "item", id: remote }, { type: "item", id: "agent:local/allan" }, true)!;
    expect(onAllan).toEqual({ kind: "item", group: "atlas", before: "agent:local/allan" });
    const inAtlas = dropOn(l, present, remote, onAllan);
    expect(resolve(inAtlas, present).map((g) => g.items)).toEqual([[`session:${U(2)}`], [remote, "agent:local/allan"], []]);
    const onAcme = dropAt(inAtlas, resolve(inAtlas, present), { type: "item", id: remote }, { type: "group", id: "acme" }, true)!;
    const inAcme = dropOn(inAtlas, present, remote, onAcme);
    expect(resolve(inAcme, present).map((g) => g.items)).toEqual([[`session:${U(2)}`, remote], ["agent:local/allan"], []]);
  });

  it("dropping items takes them out of every group and Ungrouped; none: null", () => {
    const l: Layout = {
      groups: [{ id: "g", name: "G", collapsed: false, items: ["session:devbox/a", "session:b"] }],
      ungrouped: { collapsed: false, items: ["session:devbox/c"] },
    };
    expect(dropItems(l, (k) => k.startsWith("session:devbox/"))).toEqual({
      groups: [{ id: "g", name: "G", collapsed: false, items: ["session:b"] }],
      ungrouped: { collapsed: false, items: [] },
    });
    expect(dropItems(l, () => false)).toBeNull();
  });
});

describe("a machine's own groups, merged in once", () => {
  const mine: Layout = {
    groups: [{ id: "acme", name: "Acme", collapsed: true, items: [`session:${U(1)}`, `session:devbox/${U(9)}`] }],
    ungrouped: { collapsed: false, items: [`session:devbox/${U(3)}`] },
  };
  const theirs: Layout = {
    groups: [
      { id: "x1", name: " acme ", collapsed: false, items: [`session:${U(2)}`, `session:${U(3)}`, `session:${U(9)}`, "agent:local/scout"] },
      { id: "x2", name: "Infra", collapsed: true, items: [`session:${U(4)}`] },
      { id: "x3", name: "Empty", collapsed: false, items: [] },
    ],
    ungrouped: { collapsed: false, items: [`session:${U(5)}`] },
  };

  it("joins the group of the same name, or becomes one; its agents and Ungrouped stay out", () => {
    let n = 0;
    const l = mergeMachineLayout(mine, "devbox", theirs, () => `new-${++n}`);
    expect(l.groups).toEqual([
      // Already grouped here (U9): stays where it is. U3 leaves Ungrouped for Acme.
      { id: "acme", name: "Acme", collapsed: true, items: [`session:${U(1)}`, `session:devbox/${U(9)}`, `session:devbox/${U(2)}`, `session:devbox/${U(3)}`] },
      { id: "new-1", name: "Infra", collapsed: false, items: [`session:devbox/${U(4)}`] },
      { id: "new-2", name: "Empty", collapsed: false, items: [] },
    ]);
    expect(l.ungrouped.items).toEqual([]);
  });

  it("this computer's own layout, or a machine with no groups, changes nothing", () => {
    expect(mergeMachineLayout(mine, "local", theirs, () => "x")).toBe(mine);
    expect(mergeMachineLayout(mine, "devbox", EMPTY_LAYOUT, () => "x")).toBe(mine);
  });
});

describe("following the machines' sessions", () => {
  let stop: () => void;
  const say = (e: Record<string, unknown>) => deliver({ ...e, machine: "devbox" } as never);

  beforeEach(() => {
    useMachineSessions.setState({ seen: {}, merged: [] });
    useMachines.setState({ machines: [devbox()], listed: true });
    useHubLayout.setState({ layout: null, kept: false });
    useDesk.setState({ hub: null, detached: false, engines: {}, sessions: {} });
    useSettings.setState({
      loaded: true,
      groups: [{ id: "acme", name: "Acme", collapsed: false, items: [`session:devbox/${U(1)}`, `session:devbox/${U(2)}`, `session:${U(7)}`] }],
      ungrouped: { collapsed: false, items: [] },
      sessionNames: {},
    });
    stop = followMachineSessions();
  });
  afterEach(() => stop());

  it("this computer's hub forgetting its own never takes a machine's session", () => {
    forgetGone(() => true);
    expect(layoutOf().groups[0]!.items).toEqual([`session:devbox/${U(1)}`, `session:devbox/${U(2)}`]);
  });

  it("a session its machine says is gone leaves its group; one still there keeps its place", () => {
    say({ type: "snapshot", sessions: [session(U(1))], restore: [], rooms: [] });
    expect(layoutOf().groups[0]!.items).toEqual([`session:devbox/${U(1)}`, `session:${U(7)}`]);
    say({ type: "session", session: session(U(1), { state: "closed" }) });
    expect(layoutOf().groups[0]!.items).toEqual([`session:${U(7)}`]);
  });

  it("the machine going offline forgets nothing: its sessions keep their places as last seen", () => {
    useDesk.setState({ sessions: { [`devbox/${U(1)}`]: { ...(session(U(1)) as object), machine: "devbox", displayName: "Checkout" } as never } });
    expect(useMachineSessions.getState().seen[`devbox/${U(1)}`]).toEqual({ name: `hub-${U(1)}`, engine: "claude", displayName: "Checkout" });
    useMachines.setState({ machines: [devbox("unreachable")] });
    useDesk.setState({ sessions: {} });
    expect(layoutOf().groups[0]!.items).toHaveLength(3);
    expect(useMachineSessions.getState().seen[`devbox/${U(1)}`]).toBeDefined();
    // Kept with the rest of what Desk restores.
    expect(machineSessions.read()).toMatchObject({ seen: { [`devbox/${U(1)}`]: { displayName: "Checkout" } } });
  });

  it("a machine removed from Desk takes its sessions out of the groups", () => {
    useMachineSessions.setState({ seen: { [`devbox/${U(1)}`]: { name: "web", engine: "claude" } }, merged: ["devbox"] });
    useMachines.setState({ machines: [] });
    expect(layoutOf().groups[0]!.items).toEqual([`session:${U(7)}`]);
    expect(useMachineSessions.getState()).toEqual({ seen: {}, merged: [] });
  });

  it("merges a machine's groups once, when the groups here are settled", () => {
    useHubLayout.setState({ kept: null });
    const theirs: Layout = { groups: [{ id: "x", name: "Atlas", collapsed: false, items: [`session:${U(3)}`] }], ungrouped: { collapsed: false, items: [] } };
    say({ type: "snapshot", sessions: [session(U(1)), session(U(2)), session(U(3))], restore: [], rooms: [], layout: theirs });
    expect(layoutOf().groups).toHaveLength(1);
    useHubLayout.setState({ kept: false });
    expect(layoutOf().groups.map((g) => [g.name, g.items])).toEqual([
      ["Acme", [`session:devbox/${U(1)}`, `session:devbox/${U(2)}`, `session:${U(7)}`]],
      ["Atlas", [`session:devbox/${U(3)}`]],
    ]);
    expect(useMachineSessions.getState().merged).toEqual(["devbox"]);
    // Moved out by the person, it isn't merged back.
    moveItem([], `session:devbox/${U(3)}`, UNGROUPED, null);
    say({ type: "snapshot", sessions: [session(U(1)), session(U(2)), session(U(3))], restore: [], rooms: [], layout: theirs });
    expect(layoutOf().groups[1]!.items).toEqual([]);
  });

  it("on a hub that keeps the groups, sends the whole layout as changed", async () => {
    const hubLayout: Layout = { groups: [{ id: "acme", name: "Acme", collapsed: false, items: [`session:devbox/${U(1)}`] }], ungrouped: { collapsed: false, items: [] } };
    // What the hub has now: it forgot one of its own sessions meanwhile.
    const fresh: Layout = { groups: [{ id: "acme", name: "Acme", collapsed: false, items: [`session:devbox/${U(1)}`, `session:${U(7)}`] }], ungrouped: { collapsed: false, items: [] } };
    const replaceLayout = vi.fn(async (l: Layout) => l);
    useDesk.setState({ hub: { replaceLayout, layout: vi.fn(async () => fresh) } as never });
    useHubLayout.setState({ layout: hubLayout, kept: true });
    say({ type: "removed", id: U(1) });
    // At once here; on the hub, made again to what it has.
    expect(useHubLayout.getState().layout!.groups[0]!.items).toEqual([]);
    await vi.waitFor(() =>
      expect(replaceLayout).toHaveBeenCalledWith({ groups: [{ id: "acme", name: "Acme", collapsed: false, items: [`session:${U(7)}`] }], ungrouped: { collapsed: false, items: [] } }),
    );
  });

  it("a snapshot's restore list counts as still there", () => {
    expect(goneOn("devbox", { type: "snapshot", sessions: [], restore: [session(U(2))], rooms: [] } as never)!(`devbox/${U(2)}`)).toBe(false);
    expect(goneOn("devbox", { type: "snapshot", sessions: [], restore: [], rooms: [] } as never)!(`otherbox/${U(2)}`)).toBe(false);
  });
});

describe("a machine's session's name", () => {
  it("is given on its own engine, stamped with its machine", async () => {
    const mine = { nameSession: vi.fn() };
    const theirs = { nameSession: vi.fn(async (id: string, name: string) => ({ id, name: "web", displayName: name })) };
    useDesk.setState({
      hub: mine as never,
      engines: { devbox: { hub: theirs as never, connected: true, loaded: true, error: null } },
      sessions: { "devbox/s1": { id: "s1", name: "web", machine: "devbox" } as never },
    });
    nameSession("devbox/s1", "Checkout", "web");
    await vi.waitFor(() => expect(useDesk.getState().sessions["devbox/s1"]?.displayName).toBe("Checkout"));
    expect(theirs.nameSession).toHaveBeenCalledWith("s1", "Checkout");
    expect(mine.nameSession).not.toHaveBeenCalled();
    expect(useDesk.getState().sessions["devbox/s1"]?.machine).toBe("devbox");
    useDesk.setState({ hub: null, engines: {}, sessions: {} });
  });
});
