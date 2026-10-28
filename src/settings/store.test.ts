import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings, type Settings } from "../platform";
import { useSettings } from "./store";

vi.mock("../platform", () => ({ loadSettings: vi.fn(), saveSettings: vi.fn(() => Promise.resolve()) }));

const older = {
  theme: "system",
  tuple: false,
  newAgent: null,
  defaultVoice: { provider: "fish_audio" },
  agentVoices: {},
  voice: true,
  voiceEngine: "cascade",
} as Partial<Settings> as Settings;

beforeEach(() => {
  useSettings.setState({ loaded: false });
  vi.mocked(saveSettings).mockClear();
});

describe("settings", () => {
  it("an older settings file gets the default shortcuts", async () => {
    vi.mocked(loadSettings).mockResolvedValue(older);
    await useSettings.getState().load();
    expect(useSettings.getState()).toMatchObject({ voice: true, pushToTalkShortcut: "Control+Shift+Space", askShortcut: "Alt+Space" });
  });

  it("a shortcut macOS keeps, or Desk can't read, loads as the default", async () => {
    vi.mocked(loadSettings).mockResolvedValue({ ...older, pushToTalkShortcut: "Alt+Super+Space", askShortcut: "Hyper+Q" });
    await useSettings.getState().load();
    expect(useSettings.getState()).toMatchObject({ pushToTalkShortcut: "Control+Shift+Space", askShortcut: "Alt+Space" });
  });

  it("chosen shortcuts load and save with the rest", async () => {
    vi.mocked(loadSettings).mockResolvedValue({ ...older, pushToTalkShortcut: "Control+Alt+K", askShortcut: "Control+Alt+Space" });
    await useSettings.getState().load();
    useSettings.getState().set({ askShortcut: "Control+Alt+J" });
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ voice: true, pushToTalkShortcut: "Control+Alt+K", askShortcut: "Control+Alt+J" }),
    );
  });
});
