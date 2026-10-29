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

/** Where a conversation was scrolled to, when not at its newest message:
 *  the first message showing, and how far its top was from the pane's. */
export interface Anchor {
  id: string;
  offset: number;
}

/** The most conversations whose scroll position is kept. */
const MAX_ANCHORS = 50;

/** What's shown that lives in no other store, kept so Desk reopens on it. */
interface UiState {
  /** The settings page's section while it's open, else null. */
  settings: SettingsSection | null;
  /** Each agent's tab, by agent key, kept while you visit others. */
  agentTabs: Record<string, AgentTab>;
  /** Scrolled-to positions of the panes that keep one, by pane. */
  scroll: Record<string, number>;
  /** The file open in each agent's Files tab, by agent key. */
  agentFiles: Record<string, string>;
  /** The thread open in each room, by room id. */
  roomThreads: Record<string, string>;
  /** Conversations scrolled up from their newest message, by pane
   *  (`dm:<agent>`, `room:<id>`); one at its newest has none. */
  anchors: Record<string, Anchor>;
  setAgentFile: (agent: string, file: string) => void;
  setRoomThread: (room: string, thread: string | null) => void;
  setAnchor: (pane: string, anchor: Anchor | null) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setAgentTab: (agent: string, tab: AgentTab) => void;
  setScroll: (pane: string, top: number) => void;
}

export const useUi = create<UiState>((set) => ({
  settings: null,
  agentTabs: {},
  scroll: {},
  agentFiles: {},
  roomThreads: {},
  anchors: {},
  setAgentFile: (agent, file) => set((s) => ({ agentFiles: { ...s.agentFiles, [agent]: file } })),
  setRoomThread: (room, thread) =>
    set((s) => {
      const { [room]: _was, ...rest } = s.roomThreads;
      return { roomThreads: thread ? { ...rest, [room]: thread } : rest };
    }),
  setAnchor: (pane, anchor) =>
    set((s) => {
      const was = s.anchors[pane];
      if (anchor ? was?.id === anchor.id && was.offset === anchor.offset : !was) return s;
      const { [pane]: _was, ...rest } = s.anchors;
      if (!anchor) return { anchors: rest };
      // The newest last; the oldest go past the limit.
      const kept = Object.entries(rest).slice(-(MAX_ANCHORS - 1));
      return { anchors: { ...Object.fromEntries(kept), [pane]: anchor } };
    }),
  openSettings: (section = "appearance") => set({ settings: section }),
  closeSettings: () => set({ settings: null }),
  setAgentTab: (agent, tab) => set((s) => ({ agentTabs: { ...s.agentTabs, [agent]: tab } })),
  setScroll: (pane, top) => set((s) => (s.scroll[pane] === top ? s : { scroll: { ...s.scroll, [pane]: top } })),
}));
