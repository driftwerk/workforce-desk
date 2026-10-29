import { create } from "zustand";
import { EMPTY_LAYOUT } from "../groups/model";
import { loadSettings, saveSettings, type Settings, type VoiceSpec } from "../platform";
import { choose, DEFAULT_SHORTCUTS, resolve, type ShortcutId } from "../shortcuts/keys";
import { DEFAULT_PICK, useThemeStore } from "../theme/store";

interface SettingsStore extends Settings {
  /** Each shortcut's keys: the chosen ones, else the default. */
  keys: Record<ShortcutId, string>;
  loaded: boolean;
  load: () => Promise<void>;
  set: (patch: Partial<Settings>) => void;
  setShortcut: (id: ShortcutId, accel: string) => void;
}

/** Desk's settings file, mirrored here; the theme choice lives in the theme
 *  store and is saved with the rest. A chosen shortcut that's unreadable,
 *  can't be Desk's, or has another shortcut's keys loads as its default. */
export const useSettings = create<SettingsStore>((set, get) => ({
  theme: "system",
  themePick: DEFAULT_PICK,
  tuple: false,
  newAgent: null,
  defaultVoice: { provider: "fish_audio", voice: "802e3bc2b27e49c2995d23ef70e6ac89" },
  agentVoices: {},
  voice: false,
  voiceEngine: "cascade",
  shortcuts: {},
  groups: EMPTY_LAYOUT.groups,
  ungrouped: EMPTY_LAYOUT.ungrouped,
  sessionNames: {},
  keys: DEFAULT_SHORTCUTS,
  loaded: false,
  load: async () => {
    const s = await loadSettings();
    // The pick first: a saved theme other than Auto, Night and Day (an older
    // Desk's "harbour") is the chooser's, and setting it picks it again.
    useThemeStore.getState().setPick(s.themePick ?? DEFAULT_PICK);
    useThemeStore.getState().setChoice(s.theme);
    const { keys, chosen } = resolve(s.shortcuts ?? {});
    set({
      ...s,
      theme: useThemeStore.getState().choice,
      themePick: useThemeStore.getState().pick,
      shortcuts: chosen,
      keys,
      defaultVoice: repairVoice(s.defaultVoice) ?? s.defaultVoice,
      agentVoices: repairVoices(s.agentVoices),
      groups: s.groups ?? EMPTY_LAYOUT.groups,
      ungrouped: s.ungrouped ?? EMPTY_LAYOUT.ungrouped,
      sessionNames: s.sessionNames ?? {},
      loaded: true,
    });
  },
  set: (patch) => {
    if (patch.shortcuts) {
      const { keys, chosen } = resolve(patch.shortcuts);
      set({ ...patch, shortcuts: chosen, keys });
    } else set(patch);
    const s = get();
    if (!s.loaded) return;
    void saveSettings({
      theme: s.theme,
      themePick: s.themePick,
      tuple: s.tuple,
      newAgent: s.newAgent,
      defaultVoice: s.defaultVoice,
      agentVoices: s.agentVoices,
      voice: s.voice,
      voiceEngine: s.voiceEngine,
      shortcuts: s.shortcuts,
      groups: s.groups,
      ungrouped: s.ungrouped,
      sessionNames: s.sessionNames,
    });
  },
  setShortcut: (id, accel) => get().set({ shortcuts: choose(get().shortcuts, id, accel) }),
}));

useThemeStore.subscribe((s, before) => {
  if (s.choice !== before.choice || s.pick !== before.pick) useSettings.getState().set({ theme: s.choice, themePick: s.pick });
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
