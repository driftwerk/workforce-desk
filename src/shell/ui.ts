import { create } from "zustand";

export const SETTINGS_SECTIONS = {
  appearance: "Appearance",
  hubs: "Workspaces",
  providers: "Providers",
  voices: "Voices",
  calls: "Calls and voice",
  shortcuts: "Shortcuts",
  help: "Help",
} as const;
export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

export type AgentTab = "chat" | "settings" | "files";

/** What's shown that lives in no other store, kept so Desk reopens on it. */
interface UiState {
  /** The settings page's section while it's open, else null. */
  settings: SettingsSection | null;
  /** Each agent's tab, by agent key, kept while you visit others. */
  agentTabs: Record<string, AgentTab>;
  /** Scrolled-to positions of the panes that keep one, by pane. */
  scroll: Record<string, number>;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setAgentTab: (agent: string, tab: AgentTab) => void;
  setScroll: (pane: string, top: number) => void;
}

export const useUi = create<UiState>((set) => ({
  settings: null,
  agentTabs: {},
  scroll: {},
  openSettings: (section = "appearance") => set({ settings: section }),
  closeSettings: () => set({ settings: null }),
  setAgentTab: (agent, tab) => set((s) => ({ agentTabs: { ...s.agentTabs, [agent]: tab } })),
  setScroll: (pane, top) => set((s) => (s.scroll[pane] === top ? s : { scroll: { ...s.scroll, [pane]: top } })),
}));
