import { create } from "zustand";
import { loadSettings, saveSettings, type Settings, type VoiceSpec } from "../platform";
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
      defaultVoice: repairVoice(s.defaultVoice) ?? s.defaultVoice,
      agentVoices: repairVoices(s.agentVoices),
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

/** Kokoro's own voices are named like af_heart or bm_george. */
const KOKORO_VOICE = /^[ab][fm]_[a-z]+$/;
/** Fish Audio's voices are 32-hex model ids. */
const FISH_VOICE = /^[0-9a-f]{32}$/;

/** A saved voice whose provider can't play it — an older picker could save a
 *  Fish Audio voice under Kokoro, which then spoke in its own default — put
 *  back under the provider the voice belongs to; null when it can't be. */
export const repairVoice = (v: VoiceSpec | undefined): VoiceSpec | null => {
  if (!v || v.provider !== "kokoro" || !v.voice || KOKORO_VOICE.test(v.voice)) return v ?? null;
  return FISH_VOICE.test(v.voice) ? { provider: "fish_audio", voice: v.voice } : null;
};

export const repairVoices = (all: Record<string, VoiceSpec> | undefined): Record<string, VoiceSpec> =>
  Object.fromEntries(
    Object.entries(all ?? {}).flatMap(([k, v]) => {
      const fixed = repairVoice(v);
      return fixed ? [[k, fixed]] : [];
    }),
  );
