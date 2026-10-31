import { create } from "zustand";
import type { PanelKind } from "../panels/layout";

export const SETTINGS_SECTIONS = {
  profile: "Profile",
  appearance: "Appearance",
  chat: "Chat",
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

/** A right-hand panel filling the main area, and the docked one opened
 *  beside it, if any. */
export interface PanelFocus {
  kind: PanelKind;
  beside: PanelKind | null;
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
  /** Each right-hand panel kind's width, once it's been dragged. */
  panelWidths: Partial<Record<PanelKind, number>>;
  /** The panel filling the main area, else null. */
  panelFocus: PanelFocus | null;
  /** The Floor's Activity list is open, not docked as a tab. */
  activityOpen: boolean;
  setActivityOpen: (open: boolean) => void;
  /** Kind `kind`'s width; null puts back its default. */
  setPanelWidth: (kind: PanelKind, width: number | null) => void;
  /** Panel `kind` fills the main area; what was beside it stays docked. */
  focusPanel: (kind: PanelKind) => void;
  /** Everything back as it was before a panel was focused. */
  unfocusPanel: () => void;
  /** Docked panel `kind` opens beside the focused one (null folds it back). */
  setBeside: (kind: PanelKind | null) => void;
  /** Panel `kind` closed: it's no longer focused or beside. */
  panelClosed: (kind: PanelKind) => void;
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
  panelWidths: {},
  panelFocus: null,
  activityOpen: true,
  setActivityOpen: (activityOpen) => set((s) => (s.activityOpen === activityOpen ? s : { activityOpen })),
  setPanelWidth: (kind, width) =>
    set((s) => {
      if (s.panelWidths[kind] === (width ?? undefined)) return s;
      const { [kind]: _was, ...rest } = s.panelWidths;
      return { panelWidths: width === null ? rest : { ...rest, [kind]: Math.round(width) } };
    }),
  focusPanel: (kind) => set((s) => (s.panelFocus?.kind === kind ? s : { panelFocus: { kind, beside: null } })),
  unfocusPanel: () => set((s) => (s.panelFocus ? { panelFocus: null } : s)),
  setBeside: (kind) =>
    set((s) => (s.panelFocus && s.panelFocus.beside !== kind && s.panelFocus.kind !== kind ? { panelFocus: { ...s.panelFocus, beside: kind } } : s)),
  panelClosed: (kind) =>
    set((s) => {
      const f = s.panelFocus;
      if (!f) return s;
      if (f.kind === kind) return { panelFocus: null };
      return f.beside === kind ? { panelFocus: { ...f, beside: null } } : s;
    }),
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
