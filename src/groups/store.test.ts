import { beforeEach, describe, expect, it, vi } from "vitest";
import { deskListeners, useDesk } from "../hub/store";
import type { DeskEvent, Session } from "../hub/types";
import { loadSettings, saveSettings, type Settings } from "../platform";
import { useSettings } from "../settings/store";
import { createGroup, EMPTY_LAYOUT, moveItem as moved, UNGROUPED, type Layout } from "./model";
import { sessionName } from "./names";
import { changeLayout, collapseGroup, currentLayout, moveItem, nameSession, newGroup, onHub, renameGroup, useHubLayout } from "./store";

vi.mock("../platform", () => ({ loadSettings: vi.fn(), saveSettings: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));

const file = (more: Partial<Settings> = {}) =>
  ({
    theme: "system",
    tuple: false,
    newAgent: null,
    defaultVoice: { provider: "fish_audio" },
    agentVoices: {},
    voice: false,
    voiceEngine: "cascade",
    shortcuts: {},
    ...more,
  }) as Settings;

const session = (id: string, state: Session["state"] = "idle") => ({ id, name: `hub-${id}`, state }) as Session;

const send = (e: import("../hub/types").DeskEvent) => deskListeners.forEach((f) => f(e));

beforeEach(() => {
  useSettings.setState({ loaded: false, ...EMPTY_LAYOUT, sessionNames: {}, layoutOnHub: false });
  vi.mocked(saveSettings).mockClear();
});

describe("saved groups", () => {
  it("an older settings file has no groups and no names", async () => {
    vi.mocked(loadSettings).mockResolvedValue(file());
    await useSettings.getState().load();
    expect(useSettings.getState()).toMatchObject({ groups: [], ungrouped: { collapsed: false, items: [] }, sessionNames: {} });
  });

  it("groups, their order and names save with the rest of the settings and load back", async () => {
    vi.mocked(loadSettings).mockResolvedValue(file());
    await useSettings.getState().load();
    changeLayout((l) => createGroup(l, "g1", "Acme"));
    changeLayout((l) => moved(l, ["session:s1"], "session:s1", "g1", null));
    nameSession("s1", "release notes", "hub-s1");
    const saved = vi.mocked(saveSettings).mock.lastCall![0];
    expect(saved).toMatchObject({
      voiceEngine: "cascade",
      groups: [{ id: "g1", name: "Acme", collapsed: false, items: ["session:s1"] }],
      ungrouped: { collapsed: false, items: [] },
      sessionNames: { s1: "release notes" },
    });
    useSettings.setState({ loaded: false, ...EMPTY_LAYOUT, sessionNames: {} });
    vi.mocked(loadSettings).mockResolvedValue(saved as Settings);
    await useSettings.getState().load();
    expect(useSettings.getState().groups[0]!.items).toEqual(["session:s1"]);
    expect(sessionName("s1", "hub-s1")).toBe("release notes");
  });

  it("an empty name, or the hub's own, goes back to the hub's", async () => {
    vi.mocked(loadSettings).mockResolvedValue(file({ sessionNames: { s1: "mine" } }));
    await useSettings.getState().load();
    nameSession("s1", "  ", "hub-s1");
    expect(sessionName("s1", "hub-s1")).toBe("hub-s1");
    nameSession("s1", "hub-s1", "hub-s1");
    expect(useSettings.getState().sessionNames).toEqual({});
  });
});

describe("sessions that are gone", () => {
  const groups = [{ id: "g1", name: "Acme", collapsed: false, items: ["agent:remote/ada", "session:s1", "session:s2", "session:s3"] }];

  it("drop out of groups as the hub removes or closes them, names too; agents stay", async () => {
    vi.mocked(loadSettings).mockResolvedValue(file({ groups, sessionNames: { s1: "one", s2: "two" } }));
    await useSettings.getState().load();
    send({ type: "removed", id: "s1" });
    send({ type: "session", session: session("s2", "closed") });
    send({ type: "session", session: session("s3", "working") });
    expect(useSettings.getState().groups[0]!.items).toEqual(["agent:remote/ada", "session:s3"]);
    expect(useSettings.getState().sessionNames).toEqual({});
  });

  it("a snapshot without them forgets them, even one that arrives before the settings are read", async () => {
    send({ type: "snapshot", sessions: [session("s2")], restore: [session("s3")], rooms: [] });
    vi.mocked(loadSettings).mockResolvedValue(file({ groups, sessionNames: { s1: "one" } }));
    await useSettings.getState().load();
    expect(useSettings.getState().groups[0]!.items).toEqual(["agent:remote/ada", "session:s2", "session:s3"]);
    expect(useSettings.getState().sessionNames).toEqual({});
  });
});

describe("on a hub that keeps the groups and names", () => {
  const hubLayout: Layout = { groups: [{ id: "h1", name: "Hub's", collapsed: false, items: ["session:s1"] }], ungrouped: { collapsed: false, items: [] } };
  const snapshot = (layout?: Layout): DeskEvent => ({ type: "snapshot", sessions: [session("s1"), session("s2")], restore: [], rooms: [], layout });

  const fakeHub = () => {
    const answer = (l: Layout) => vi.fn(async (..._: unknown[]) => l);
    const hub = {
      importLayout: vi.fn(async (i: { layout: Layout; sessionNames: Record<string, string> }) => ({ imported: true, layout: i.layout, sessionNames: i.sessionNames })),
      layout: answer(hubLayout),
      putLayout: vi.fn(async (l: Layout) => l),
      createGroup: answer(hubLayout),
      updateGroup: answer(hubLayout),
      moveGroup: answer(hubLayout),
      putInGroup: answer(hubLayout),
      nameSession: vi.fn(async (id: string, name: string | null) => ({ ...session(id), displayName: name })),
    };
    useDesk.setState({ hub: hub as never, detached: false, sessions: { s1: session("s1"), s2: session("s2") }, restore: [] });
    return hub;
  };

  beforeEach(() => {
    useDesk.setState({ hub: null });
    useHubLayout.setState({ layout: null });
  });

  it("is handed Desk's own once, after the settings are read, and followed from then on", async () => {
    const hub = fakeHub();
    send(snapshot(hubLayout));
    expect(hub.importLayout).not.toHaveBeenCalled();
    const groups = [{ id: "g1", name: "Acme", collapsed: false, items: ["session:s1"] }];
    vi.mocked(loadSettings).mockResolvedValue(file({ groups, sessionNames: { s1: "release notes" } }));
    await useSettings.getState().load();
    await vi.waitFor(() => expect(useSettings.getState().layoutOnHub).toBe(true));
    expect(hub.importLayout).toHaveBeenCalledWith({ layout: { groups, ungrouped: EMPTY_LAYOUT.ungrouped }, sessionNames: { s1: "release notes" } });
    expect(currentLayout().groups).toEqual(groups);
    expect(vi.mocked(saveSettings).mock.lastCall![0]).toMatchObject({ layoutOnHub: true, groups });
    // The next connection follows the hub's, without handing anything over.
    send(snapshot(hubLayout));
    expect(hub.importLayout).toHaveBeenCalledTimes(1);
    expect(currentLayout()).toEqual(hubLayout);
    send({ type: "layout", layout: EMPTY_LAYOUT });
    expect(currentLayout()).toEqual(EMPTY_LAYOUT);
  });

  it("a detached window follows the hub's and leaves handing over to the main one", async () => {
    const hub = fakeHub();
    useDesk.setState({ detached: true });
    vi.mocked(loadSettings).mockResolvedValue(file());
    await useSettings.getState().load();
    send(snapshot(hubLayout));
    expect(currentLayout()).toEqual(hubLayout);
    expect(hub.importLayout).not.toHaveBeenCalled();
  });

  it("a hub without them leaves them in the settings", async () => {
    fakeHub();
    vi.mocked(loadSettings).mockResolvedValue(file({ layoutOnHub: true }));
    await useSettings.getState().load();
    send(snapshot(hubLayout));
    expect(onHub()).toBe(true);
    send(snapshot());
    expect(onHub()).toBe(false);
    newGroup("g9", "Local");
    expect(useSettings.getState().groups.map((g) => g.id)).toEqual(["g9"]);
  });

  it("changes show at once, go through the group routes, and Ungrouped's order goes whole", async () => {
    const hub = fakeHub();
    vi.mocked(loadSettings).mockResolvedValue(file({ layoutOnHub: true }));
    await useSettings.getState().load();
    send(snapshot(hubLayout));
    const present = ["session:s1", "session:s2"];
    renameGroup("h1", " Renamed ");
    expect(currentLayout().groups[0]!.name).toBe("Renamed");
    moveItem(present, "session:s2", "h1", "session:s1");
    expect(currentLayout().groups[0]!.items).toEqual(["session:s2", "session:s1"]);
    await vi.waitFor(() => expect(hub.updateGroup).toHaveBeenCalledWith("h1", { name: "Renamed" }));
    await vi.waitFor(() => expect(hub.putInGroup).toHaveBeenCalledWith("h1", "session:s2", "session:s1"));
    // The hub answered with its own (s2 in no group): that shows.
    await vi.waitFor(() => expect(currentLayout()).toEqual(hubLayout));
    // Out of a group to the very end of Ungrouped, after s2, which only
    // shows there: Ungrouped's order is sent whole.
    moveItem(present, "session:s1", UNGROUPED, null);
    await vi.waitFor(() => expect(hub.putLayout).toHaveBeenCalled());
    expect(hub.putLayout.mock.lastCall![0].ungrouped.items).toEqual(["session:s2", "session:s1"]);
    // What the hub answers last is what shows.
    await vi.waitFor(() => expect(currentLayout()).toEqual(hub.putLayout.mock.lastCall![0]));
    expect(useSettings.getState().groups).toEqual([]);
  });

  it("a layout announced while a change is on its way waits for it to be answered", async () => {
    const hub = fakeHub();
    vi.mocked(loadSettings).mockResolvedValue(file({ layoutOnHub: true }));
    await useSettings.getState().load();
    send(snapshot(hubLayout));
    let answer: (l: Layout) => void = () => {};
    hub.updateGroup.mockImplementation(() => new Promise<Layout>((r) => (answer = r)));
    collapseGroup("h1", true);
    const collapsedLayout = currentLayout();
    expect(collapsedLayout.groups[0]!.collapsed).toBe(true);
    send({ type: "layout", layout: hubLayout });
    expect(currentLayout()).toBe(collapsedLayout);
    await vi.waitFor(() => expect(hub.updateGroup).toHaveBeenCalled());
    answer(collapsedLayout);
    await vi.waitFor(() => expect(currentLayout()).toEqual(collapsedLayout));
  });

  it("names a session on the hub and shows the name it keeps", async () => {
    const hub = fakeHub();
    vi.mocked(loadSettings).mockResolvedValue(file({ layoutOnHub: true, sessionNames: { s1: "old local" } }));
    await useSettings.getState().load();
    send(snapshot(hubLayout));
    expect(sessionName("s1", "hub-s1")).toBe("hub-s1");
    nameSession("s1", " ledger ", "hub-s1");
    expect(sessionName("s1", "hub-s1")).toBe("ledger");
    expect(hub.nameSession).toHaveBeenCalledWith("s1", "ledger");
    nameSession("s1", "hub-s1", "hub-s1");
    expect(hub.nameSession).toHaveBeenLastCalledWith("s1", null);
    await vi.waitFor(() => expect(useDesk.getState().sessions.s1!.displayName).toBeNull());
    expect(useSettings.getState().sessionNames).toEqual({ s1: "old local" });
  });
});
