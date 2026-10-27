import { create } from "zustand";
import { loadSettings, saveSettings, type Settings } from "../platform";
import { useThemeStore } from "../theme/store";

interface SettingsStore extends Settings {
  loaded: boolean;
  load: () => Promise<void>;
  set: (patch: Partial<Settings>) => void;
}

/** Desk's settings file, mirrored here; the theme choice lives in the theme
 *  store and is saved with the rest. */
export const useSettings = create<SettingsStore>((set, get) => ({
  theme: "system",
  tuple: false,
  plan: null,
  defaultVoice: { provider: "fish_audio", voice: "802e3bc2b27e49c2995d23ef70e6ac89" },
  agentVoices: {},
  voice: false,
  voiceEngine: "cascade",
  loaded: false,
  load: async () => {
    const s = await loadSettings();
    useThemeStore.getState().setChoice(s.theme);
    set({ ...s, loaded: true });
  },
  set: (patch) => {
    set(patch);
    const { theme, tuple, plan, defaultVoice, agentVoices, voice, voiceEngine, loaded } = get();
    if (loaded) void saveSettings({ theme, tuple, plan, defaultVoice, agentVoices, voice, voiceEngine });
  },
}));

useThemeStore.subscribe((s, before) => {
  if (s.choice !== before.choice) useSettings.getState().set({ theme: s.choice });
});
