// `ui.main`: what the main window shows — Floor or Rooms, the room or DM
// that's open, the session card, the DM beside the Floor, the right-hand
// panels' widths and the one focused, whether the Floor's Activity list is
// open or docked, the settings page and its section,
// each agent's tab and the panes' scroll positions. Dialogs aren't kept: they
// reopen on nothing.

import { useChat } from "../chat/store";
import { useGrids } from "../grids/store";
import { useDesk, type View } from "../hub/store";
import { isPanelKind, MAX_KEPT, MIN_WIDTH, type PanelKind } from "../panels/layout";
import { SETTINGS_SECTIONS, useUi, type AgentTab, type Anchor, type PanelFocus, type SettingsSection } from "../shell/ui";
import type { Restorable } from "./boot";

export const MAIN_UI_KEY = "ui.main";

export interface MainUi {
  v: 1;
  view: View;
  /** The open room's id. */
  room: string | null;
  /** The DM's agent key (`hub/agent`): shown in Rooms when no room is. */
  dm: string | null;
  /** The open session card's id. */
  session: string | null;
  /** The agent key whose DM is in the side panel beside the Floor. */
  panelAgent: string | null;
  /** The grid the Grids view shows (none: there are no grids). */
  grid: string | null;
  settings: SettingsSection | null;
  agentTabs: Record<string, AgentTab>;
  scroll: Record<string, number>;
  /** The file open in each agent's Files tab. */
  agentFiles: Record<string, string>;
  /** The thread open in each room. */
  roomThreads: Record<string, string>;
  /** Conversations scrolled up from their newest message. */
  anchors: Record<string, Anchor>;
  /** Each right-hand panel kind's width, once dragged. */
  panelWidths: Partial<Record<PanelKind, number>>;
  /** The panel filling the main area, and the one beside it. */
  panelFocus: PanelFocus | null;
  /** The Floor's Activity list is open (false: docked as a tab). */
  activity: boolean;
  /** Rooms shows the Unread page; absent from an older Desk's. */
  inbox?: boolean;
}

export const DEFAULT_UI: MainUi = {
  v: 1,
  view: "floor",
  room: null,
  dm: null,
  session: null,
  panelAgent: null,
  grid: null,
  settings: null,
  agentTabs: {},
  scroll: {},
  agentFiles: {},
  roomThreads: {},
  anchors: {},
  panelWidths: {},
  panelFocus: null,
  activity: true,
  inbox: false,
};

const TABS: readonly string[] = ["chat", "settings", "files"];
const text = (x: unknown): string | null => (typeof x === "string" && x ? x : null);

const focusOf = (x: unknown): PanelFocus | null => {
  if (!x || typeof x !== "object") return null;
  const f = x as Record<string, unknown>;
  if (!isPanelKind(f.kind)) return null;
  return { kind: f.kind, beside: isPanelKind(f.beside) && f.beside !== f.kind ? f.beside : null };
};

/** A saved value as a `MainUi`: each field that's missing or unreadable
 *  (an older or newer Desk's, or a damaged one) is its default. */
export const sanitize = (raw: unknown): MainUi => {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const record = <T>(x: unknown, ok: (v: unknown) => v is T): Record<string, T> =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter((e): e is [string, T] => ok(e[1])))
      : {};
  return {
    v: 1,
    view: o.view === "rooms" || o.view === "floor" || o.view === "grids" ? o.view : DEFAULT_UI.view,
    room: text(o.room),
    dm: text(o.dm),
    session: text(o.session),
    panelAgent: text(o.panelAgent),
    grid: text(o.grid),
    settings: typeof o.settings === "string" && o.settings in SETTINGS_SECTIONS ? (o.settings as SettingsSection) : null,
    agentTabs: record(o.agentTabs, (v): v is AgentTab => typeof v === "string" && TABS.includes(v)),
    scroll: record(o.scroll, (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0),
    agentFiles: record(o.agentFiles, (v): v is string => typeof v === "string" && v !== ""),
    roomThreads: record(o.roomThreads, (v): v is string => typeof v === "string" && v !== ""),
    anchors: record(
      o.anchors,
      (v): v is Anchor =>
        !!v &&
        typeof v === "object" &&
        typeof (v as Anchor).id === "string" &&
        typeof (v as Anchor).offset === "number" &&
        Number.isFinite((v as Anchor).offset),
    ),
    panelWidths: Object.fromEntries(
      Object.entries(record(o.panelWidths, (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_KEPT)).filter(
        ([k]) => isPanelKind(k),
      ),
    ),
    panelFocus: focusOf(o.panelFocus),
    activity: o.activity !== false,
    inbox: o.inbox === true,
  };
};

export const capture = (): MainUi => {
  const desk = useDesk.getState();
  const chat = useChat.getState();
  const ui = useUi.getState();
  return {
    v: 1,
    view: desk.view,
    room: desk.activeRoom,
    dm: chat.activeAgent,
    session: desk.openId,
    panelAgent: chat.panelAgent,
    grid: useGrids.getState().active,
    settings: ui.settings,
    agentTabs: ui.agentTabs,
    scroll: ui.scroll,
    agentFiles: ui.agentFiles,
    roomThreads: ui.roomThreads,
    anchors: ui.anchors,
    panelWidths: ui.panelWidths,
    panelFocus: ui.panelFocus,
    activity: ui.activityOpen,
    inbox: desk.inbox,
  };
};

/** Shows `ui`. What it names that isn't loaded yet (the roster, the hub's
 *  rooms and sessions) shows once it is. */
export const apply = (ui: MainUi): void => {
  useDesk.setState({ view: ui.view, activeRoom: ui.room, openId: ui.session, inbox: ui.inbox ?? false });
  useGrids.setState({ active: ui.grid });
  useChat.setState({ activeAgent: ui.dm, panelAgent: ui.panelAgent });
  useUi.setState({
    settings: ui.settings,
    agentTabs: ui.agentTabs,
    scroll: ui.scroll,
    agentFiles: ui.agentFiles,
    roomThreads: ui.roomThreads,
    anchors: ui.anchors,
    panelWidths: ui.panelWidths,
    panelFocus: ui.panelFocus,
    activityOpen: ui.activity,
  });
  if (ui.room) void useDesk.getState().reloadRoom(ui.room);
  if (ui.dm) useChat.getState().reopenDm();
};

export const mainUi: Restorable = {
  key: MAIN_UI_KEY,
  read: capture,
  write: (v) => apply(sanitize(v)),
  subscribe: (onChange) => {
    const stops = [useDesk.subscribe(onChange), useChat.subscribe(onChange), useUi.subscribe(onChange), useGrids.subscribe(onChange)];
    return () => stops.forEach((s) => s());
  },
};
