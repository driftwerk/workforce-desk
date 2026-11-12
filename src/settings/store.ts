import { create } from "zustand";
import { EMPTY_LAYOUT } from "../groups/model";
import { loadSettings, saveSettings, type CustomVoice, type Settings, type SetupProgress, type VoiceSpec } from "../platform";

/** The setup as an older file has it: never offered. */
export const NO_SETUP: SetupProgress = { started: false, closed: false, skipped: [] };
import { choose, defaultShortcuts, resolve, type ShortcutId } from "../shortcuts/keys";
import { DEFAULT_PICK, useThemeStore } from "../theme/store";

interface SettingsStore extends Settings {
  emoticons: boolean;
  imageSites: string[];
  setup: SetupProgress;
  writtenReplies: string[];
  /** Each shortcut's keys: the chosen ones, else the default. */
  keys: Record<ShortcutId, string>;
  loaded: boolean;
  load: () => Promise<void>;
  set: (patch: Partial<Settings>) => void;
  setShortcut: (id: ShortcutId, accel: string) => void;
}

/** The settings read under way, if any. */
let reading: Promise<void> | null = null;

/** Reads Desk's settings file into the store. */
const readSettings = async (set: (patch: Partial<SettingsStore>) => void): Promise<void> => {
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
    customVoices: s.customVoices ?? {},
    groups: s.groups ?? EMPTY_LAYOUT.groups,
    ungrouped: s.ungrouped ?? EMPTY_LAYOUT.ungrouped,
    sessionNames: s.sessionNames ?? {},
    layoutOnHub: s.layoutOnHub ?? false,
    emoticons: s.emoticons ?? true,
    imageSites: s.imageSites ?? [],
    setup: s.setup ?? NO_SETUP,
    writtenReplies: s.writtenReplies ?? [],
    loaded: true,
  });
};

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
  customVoices: {},
  voice: false,
  writtenReplies: [],
  voiceEngine: "cascade",
  shortcuts: {},
  groups: EMPTY_LAYOUT.groups,
  ungrouped: EMPTY_LAYOUT.ungrouped,
  sessionNames: {},
  layoutOnHub: false,
  emoticons: true,
  imageSites: [],
  setup: NO_SETUP,
  keys: defaultShortcuts(),
  loaded: false,
  // One read at a time: a second caller (the shell, after the read before
  // the first render) waits on the one under way.
  load: () => (reading ??= readSettings(set).finally(() => (reading = null))),
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
      customVoices: s.customVoices,
      voice: s.voice,
      writtenReplies: s.writtenReplies,
      voiceEngine: s.voiceEngine,
      shortcuts: s.shortcuts,
      groups: s.groups,
      ungrouped: s.ungrouped,
      sessionNames: s.sessionNames,
      layoutOnHub: s.layoutOnHub,
      emoticons: s.emoticons,
      imageSites: s.imageSites,
      setup: s.setup,
    });
  },
  setShortcut: (id, accel) => get().set({ shortcuts: choose(get().shortcuts, id, accel) }),
}));

useThemeStore.subscribe((s, before) => {
  if (s.choice !== before.choice || s.pick !== before.pick) useSettings.getState().set({ theme: s.choice, themePick: s.pick });
});

/** Keeps a voice added by id under `provider` (once: adding it again
 *  renames it). */
export const addCustomVoice = (provider: string, voice: CustomVoice): void => {
  const { customVoices, set } = useSettings.getState();
  const others = (customVoices[provider] ?? []).filter((v) => v.id !== voice.id);
  set({ customVoices: { ...customVoices, [provider]: [...others, voice] } });
};

/** Forgets a voice added by id. Agents already speaking with it keep it:
 *  their voice is the id itself, which goes on working. */
export const removeCustomVoice = (provider: string, id: string): void => {
  const { customVoices, set } = useSettings.getState();
  const left = (customVoices[provider] ?? []).filter((v) => v.id !== id);
  const { [provider]: _was, ...others } = customVoices;
  set({ customVoices: left.length ? { ...others, [provider]: left } : others });
};

/** Pictures from `site` show in agent markdown without a click. */
export const alwaysShowImagesFrom = (site: string): void => {
  const { imageSites, set } = useSettings.getState();
  const host = site.toLowerCase();
  if (!imageSites.includes(host)) set({ imageSites: [...imageSites, host] });
};

/** Pictures from `site` wait for a click again. */
export const stopShowingImagesFrom = (site: string): void => {
  const { imageSites, set } = useSettings.getState();
  set({ imageSites: imageSites.filter((s) => s !== site.toLowerCase()) });
};

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
