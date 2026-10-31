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
    expect(useSettings.getState()).toMatchObject({ voice: true, shortcuts: {} });
    expect(useSettings.getState().keys).toMatchObject({ pushToTalk: "Control+Shift+Space", ask: "Control+Shift+K", settings: "Primary+Comma" });
  });

  it("a shortcut macOS keeps, or Desk can't read, loads as the default", async () => {
    vi.mocked(loadSettings).mockResolvedValue({ ...older, shortcuts: { pushToTalk: "Alt+Super+Space", ask: "Hyper+Q" } });
    await useSettings.getState().load();
    expect(useSettings.getState().keys).toMatchObject({ pushToTalk: "Control+Shift+Space", ask: "Control+Shift+K" });
    expect(useSettings.getState().shortcuts).toEqual({});
  });

  it("chosen shortcuts load and save with the rest, defaults left out", async () => {
    vi.mocked(loadSettings).mockResolvedValue({ ...older, shortcuts: { pushToTalk: "Control+Alt+K", ask: "Alt+Space" } });
    await useSettings.getState().load();
    expect(useSettings.getState().keys).toMatchObject({ pushToTalk: "Control+Alt+K", ask: "Alt+Space" });
    useSettings.getState().setShortcut("ask", "Control+Shift+K");
    useSettings.getState().setShortcut("newSession", "Super+Y");
    expect(saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ voice: true, shortcuts: { pushToTalk: "Control+Alt+K", newSession: "Primary+Y" } }),
    );
    expect(useSettings.getState().keys).toMatchObject({ ask: "Control+Shift+K", newSession: "Primary+Y" });
  });
});

describe("repairing saved voices", () => {
  it("puts a Fish Audio voice saved under Kokoro back under Fish Audio, and keeps real Kokoro voices", async () => {
    const { repairVoice, repairVoices } = await import("./store");
    expect(repairVoice({ provider: "kokoro", model: "kokoro-v0_19", voice: "f772ea09ebe04f66bd3e4a2be1e17329" })).toEqual({
      provider: "fish_audio",
      voice: "f772ea09ebe04f66bd3e4a2be1e17329",
    });
    expect(repairVoice({ provider: "kokoro", voice: "af_heart" })).toEqual({ provider: "kokoro", voice: "af_heart" });
    expect(repairVoice({ provider: "fish_audio", voice: "802e3bc2b27e49c2995d23ef70e6ac89" })?.provider).toBe("fish_audio");
    expect(repairVoice({ provider: "kokoro", voice: "nonsense" })).toBeNull();
    expect(repairVoices({ "local/desk": { provider: "kokoro", voice: "nonsense" }, "local/scout": { provider: "kokoro", voice: "bm_george" } })).toEqual({
      "local/scout": { provider: "kokoro", voice: "bm_george" },
    });
  });
});
