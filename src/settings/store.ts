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
    const { theme, tuple, plan, voice, voiceEngine, loaded } = get();
    if (loaded) void saveSettings({ theme, tuple, plan, voice, voiceEngine });
  },
}));

useThemeStore.subscribe((s, before) => {
  if (s.choice !== before.choice) useSettings.getState().set({ theme: s.choice });
});
