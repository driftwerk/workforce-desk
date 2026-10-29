// `ui.main`: what the main window shows — Floor or Rooms, the room or DM
// that's open, the session card, the settings page and its section, each
// agent's tab and the panes' scroll positions. Dialogs aren't kept: they
// reopen on nothing.

import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import { SETTINGS_SECTIONS, useUi, type AgentTab, type SettingsSection } from "../shell/ui";
import type { Restorable } from "./boot";

export const MAIN_UI_KEY = "ui.main";

export interface MainUi {
  v: 1;
  view: "floor" | "rooms";
  /** The open room's id. */
  room: string | null;
  /** The DM's agent key (`hub/agent`): shown in Rooms when no room is. */
  dm: string | null;
  /** The open session card's id. */
  session: string | null;
  settings: SettingsSection | null;
  agentTabs: Record<string, AgentTab>;
  scroll: Record<string, number>;
}

export const DEFAULT_UI: MainUi = {
  v: 1,
  view: "floor",
  room: null,
  dm: null,
  session: null,
  settings: null,
  agentTabs: {},
  scroll: {},
};

const TABS: readonly string[] = ["chat", "settings", "files"];
const text = (x: unknown): string | null => (typeof x === "string" && x ? x : null);

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
    view: o.view === "rooms" || o.view === "floor" ? o.view : DEFAULT_UI.view,
    room: text(o.room),
    dm: text(o.dm),
    session: text(o.session),
    settings: typeof o.settings === "string" && o.settings in SETTINGS_SECTIONS ? (o.settings as SettingsSection) : null,
    agentTabs: record(o.agentTabs, (v): v is AgentTab => typeof v === "string" && TABS.includes(v)),
    scroll: record(o.scroll, (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0),
  };
};

export const capture = (): MainUi => {
  const desk = useDesk.getState();
  const ui = useUi.getState();
  return {
    v: 1,
    view: desk.view,
    room: desk.activeRoom,
    dm: useChat.getState().activeAgent,
    session: desk.openId,
    settings: ui.settings,
    agentTabs: ui.agentTabs,
    scroll: ui.scroll,
  };
};

/** Shows `ui`. What it names that isn't loaded yet (the roster, the hub's
 *  rooms and sessions) shows once it is. */
export const apply = (ui: MainUi): void => {
  useDesk.setState({ view: ui.view, activeRoom: ui.room, openId: ui.session });
  useChat.setState({ activeAgent: ui.dm });
  useUi.setState({ settings: ui.settings, agentTabs: ui.agentTabs, scroll: ui.scroll });
  if (ui.room) void useDesk.getState().reloadRoom(ui.room);
  if (ui.dm) useChat.getState().reopenDm();
};

export const mainUi: Restorable = {
  key: MAIN_UI_KEY,
  read: capture,
  write: (v) => apply(sanitize(v)),
  subscribe: (onChange) => {
    const stops = [useDesk.subscribe(onChange), useChat.subscribe(onChange), useUi.subscribe(onChange)];
    return () => stops.forEach((s) => s());
  },
};
