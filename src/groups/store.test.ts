import { beforeEach, describe, expect, it, vi } from "vitest";
import { deskListeners } from "../hub/store";
import type { Session } from "../hub/types";
import { loadSettings, saveSettings, type Settings } from "../platform";
import { useSettings } from "../settings/store";
import { createGroup, EMPTY_LAYOUT, moveItem } from "./model";
import { sessionName } from "./names";
import { changeLayout, nameSession } from "./store";

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
  useSettings.setState({ loaded: false, ...EMPTY_LAYOUT, sessionNames: {} });
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
    changeLayout((l) => moveItem(l, ["session:s1"], "session:s1", "g1", null));
    nameSession("s1", "release notes", "hub-s1");
    const saved = vi.mocked(saveSettings).mock.lastCall![0];
    expect(saved).toMatchObject({
      voiceEngine: "cascade",
      groups: [{ id: "g1", name: "Acme", collapsed: false, items: ["session:s1"] }],
      ungrouped: { collapsed: false, items: [] },
      sessionNames: { s1: "release notes" },
    });
    useSettings.setState({ loaded: false, ...EMPTY_LAYOUT, sessionNames: {} });
    vi.mocked(loadSettings).mockResolvedValue(saved);
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
