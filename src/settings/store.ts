import { create } from "zustand";
import { loadSettings, saveSettings, type Settings } from "../platform";
import { DEFAULT_SHORTCUTS, usable } from "../shortcuts/keys";
import { useThemeStore } from "../theme/store";

interface SettingsStore extends Settings {
  loaded: boolean;
  load: () => Promise<void>;
  set: (patch: Partial<Settings>) => void;
}

/** Desk's settings file, mirrored here; the theme choice lives in the theme
 *  store and is saved with the rest. A shortcut that's missing, unreadable or
 *  one macOS keeps loads as its default. */
export const useSettings = create<SettingsStore>((set, get) => ({
  theme: "system",
  tuple: false,
  newAgent: null,
  defaultVoice: { provider: "fish_audio", voice: "802e3bc2b27e49c2995d23ef70e6ac89" },
  agentVoices: {},
  voice: false,
  voiceEngine: "cascade",
  pushToTalkShortcut: DEFAULT_SHORTCUTS.pushToTalk,
  askShortcut: DEFAULT_SHORTCUTS.ask,
  loaded: false,
  load: async () => {
    const s = await loadSettings();
    useThemeStore.getState().setChoice(s.theme);
    set({
      ...s,
      pushToTalkShortcut: usable(s.pushToTalkShortcut, "pushToTalk"),
      askShortcut: usable(s.askShortcut, "ask"),
      loaded: true,
    });
  },
  set: (patch) => {
    set(patch);
    const { theme, tuple, newAgent, defaultVoice, agentVoices, voice, voiceEngine, pushToTalkShortcut, askShortcut, loaded } = get();
    if (loaded)
      void saveSettings({ theme, tuple, newAgent, defaultVoice, agentVoices, voice, voiceEngine, pushToTalkShortcut, askShortcut });
  },
}));

useThemeStore.subscribe((s, before) => {
  if (s.choice !== before.choice) useSettings.getState().set({ theme: s.choice });
});
