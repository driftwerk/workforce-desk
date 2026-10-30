/** Desk's keyboard shortcuts, written the way the global-shortcut plugin
 *  reads them ("Control+Shift+Space"), with `Primary` for the key commands
 *  use on each system (⌘ on macOS, Ctrl elsewhere), and shown the way the
 *  system does (⌃⇧Space on macOS, Ctrl+Shift+Space elsewhere). The global
 *  ones work from any app; the rest only while Desk is in front.
 *
 *  Every function reads this computer's platform unless given one. */

import { useHost, type Platform } from "../shell/host";

export type Scope = "global" | "app";

export interface ShortcutSpec {
  id: string;
  name: string;
  about: string;
  /** The default keys. */
  keys: string;
  scope: Scope;
}

/** Every shortcut Desk has, in the order Settings lists them. Esc, Enter
 *  and the arrows in text fields and dialogs work as they do everywhere and
 *  aren't here. */
export const SHORTCUTS = [
  { id: "ask", name: "Ask anyone", about: "Opens Ask anyone from any app.", keys: "Control+Shift+K", scope: "global" },
  {
    id: "pushToTalk",
    name: "Hold to talk",
    about: "Hold to talk to an agent, let go to send. Works from any app while voice is on.",
    keys: "Control+Shift+Space",
    scope: "global",
  },
  { id: "newSession", name: "New session", about: "Starts a new session.", keys: "Primary+N", scope: "app" },
  {
    id: "newTerminal",
    name: "New terminal",
    about: "Opens a terminal in the grid you’re looking at: in its empty pane, or beside the one you’re in.",
    keys: "Primary+T",
    scope: "app",
  },
  {
    id: "fillPane",
    name: "Fill the grid",
    about: "Gives the grid pane you’re in the whole grid for a while, and puts the grid back.",
    keys: "Shift+Primary+Enter",
    scope: "app",
  },
  { id: "settings", name: "Settings", about: "Opens Settings, and goes back to your desk.", keys: "Primary+Comma", scope: "app" },
  { id: "saveFile", name: "Save a file", about: "Saves the agent file you’re editing.", keys: "Primary+S", scope: "app" },
  {
    id: "stopAnswer",
    name: "Stop an answer",
    about: "Stops the answer being written in the room or DM you’re in: the open thread’s first.",
    keys: "Primary+Period",
    scope: "app",
  },
  {
    id: "jumpNew",
    name: "Jump to new messages",
    about: "Takes you to what’s new in the room or thread you’re in.",
    keys: "Primary+J",
    scope: "app",
  },
] as const satisfies readonly ShortcutSpec[];

type Spec = (typeof SHORTCUTS)[number];
export type ShortcutId = Spec["id"];
export type GlobalShortcutId = Extract<Spec, { scope: "global" }>["id"];

export const SHORTCUT_IDS: ShortcutId[] = SHORTCUTS.map((s) => s.id);

const SPEC = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s])) as Record<ShortcutId, Spec>;

export const SHORTCUT_NAMES = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.name])) as Record<ShortcutId, string>;

export const scopeOf = (id: ShortcutId): Scope => SPEC[id].scope;

export const isGlobal = (id: ShortcutId): id is GlobalShortcutId => scopeOf(id) === "global";

export const isShortcutId = (id: string): id is ShortcutId => id in SPEC;

const platformNow = (): Platform => useHost.getState().platform;

/** The keys a person presses; `Primary` stands for the one commands use,
 *  and is how that key is written once read. */
const MODIFIERS = ["Primary", "Control", "Alt", "Shift", "Super"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** The physical key `Primary` is on each system. */
const PRIMARY: Record<Platform, Modifier> = { macos: "Super", linux: "Control", windows: "Control" };

/** How each system shows modifiers, in its own order. */
const MODIFIER_LABELS: Record<Platform, [Modifier, string][]> = {
  // Apple's order: ⌃⌥⇧⌘.
  macos: [
    ["Control", "⌃"],
    ["Alt", "⌥"],
    ["Shift", "⇧"],
    ["Primary", "⌘"],
  ],
  windows: [
    ["Primary", "Ctrl"],
    ["Alt", "Alt"],
    ["Shift", "Shift"],
    ["Super", "Win"],
  ],
  linux: [
    ["Primary", "Ctrl"],
    ["Alt", "Alt"],
    ["Shift", "Shift"],
    ["Super", "Super"],
  ],
};

const MODIFIER_ALIASES: Record<string, Modifier> = {
  PRIMARY: "Primary",
  COMMANDORCONTROL: "Primary",
  CMDORCTRL: "Primary",
  CONTROL: "Control",
  CTRL: "Control",
  ALT: "Alt",
  OPTION: "Alt",
  SHIFT: "Shift",
  SUPER: "Super",
  CMD: "Super",
  COMMAND: "Super",
  META: "Super",
  WIN: "Super",
};

/** Keys a shortcut can end in, by `KeyboardEvent.code`, as the plugin names
 *  them; `code` is where the key is, so ⌥ turning A into å doesn't matter. */
const KEYS: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Escape: "Escape",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Backslash: "Backslash",
  Semicolon: "Semicolon",
  Quote: "Quote",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Backquote: "Backquote",
  Minus: "Minus",
  Equal: "Equal",
  ...Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => [`Key${c}`, c])),
  ...Object.fromEntries([..."0123456789"].map((d) => [`Digit${d}`, d])),
  ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`F${i + 1}`, `F${i + 1}`])),
};

const KEY_NAMES = new Map(Object.values(KEYS).map((k) => [k.toUpperCase(), k]));
KEY_NAMES.set("ARROWUP", "Up").set("ARROWDOWN", "Down").set("ARROWLEFT", "Left").set("ARROWRIGHT", "Right").set("ESC", "Escape");
for (const [code, key] of Object.entries(KEYS)) KEY_NAMES.set(code.toUpperCase(), key);

/** Punctuation, shown as itself everywhere. */
const PUNCTUATION: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

/** How each system shows the other named keys. */
const KEY_LABELS: Record<Platform, Record<string, string>> = {
  macos: {
    Enter: "↩",
    Tab: "⇥",
    Backspace: "⌫",
    Delete: "⌦",
    Escape: "⎋",
    Up: "↑",
    Down: "↓",
    Left: "←",
    Right: "→",
    PageUp: "⇞",
    PageDown: "⇟",
    Home: "↖",
    End: "↘",
  },
  windows: { Escape: "Esc", Delete: "Del", PageUp: "PgUp", PageDown: "PgDn" },
  linux: { Escape: "Esc", Delete: "Del", PageUp: "PgUp", PageDown: "PgDn" },
};

interface Parsed {
  mods: Set<Modifier>;
  key: string;
}

/** `accel` with the system's command key written `Primary`, so ⌘N on macOS
 *  and Ctrl+N elsewhere read as the same shortcut, `Primary+N`. */
const parse = (accel: string, platform: Platform): Parsed | null => {
  const tokens = accel.split("+").map((t) => t.trim());
  const mods = new Set<Modifier>();
  let key: string | null = null;
  for (const t of tokens) {
    const mod = MODIFIER_ALIASES[t.toUpperCase()];
    if (mod && key === null) mods.add(mod === PRIMARY[platform] ? "Primary" : mod);
    else if (key === null && KEY_NAMES.has(t.toUpperCase())) key = KEY_NAMES.get(t.toUpperCase())!;
    else return null;
  }
  return key ? { mods, key } : null;
};

const write = ({ mods, key }: Parsed): string => [...MODIFIERS.filter((m) => mods.has(m)), key].join("+");

/** The shortcut with its modifiers in one order, so equal ones compare
 *  equal; null for one Desk can't read. */
export const normalize = (accel: string, platform: Platform = platformNow()): string | null => {
  const p = parse(accel, platform);
  return p ? write(p) : null;
};

/** The shortcut as the global-shortcut plugin takes it: `Primary` as the
 *  key it is on this system. */
export const pluginKeys = (accel: string, platform: Platform = platformNow()): string => {
  const p = parse(accel, platform);
  if (!p) return accel;
  return [...MODIFIERS.filter((m) => p.mods.has(m)).map((m) => (m === "Primary" ? PRIMARY[platform] : m)), p.key].join("+");
};

/** The keys a shortcut takes in a terminal pane. A shell reads Ctrl and a
 *  letter itself (Ctrl+N, Ctrl+T and Ctrl+S are readline's next-history,
 *  transpose and forward search), so on Windows and Linux one of Desk's
 *  that is Ctrl and a letter takes Shift as well there, as Windows
 *  Terminal, GNOME Terminal and VS Code's terminal do: Ctrl+N goes to the
 *  shell, Ctrl+Shift+N to Desk. On macOS ⌘ never reaches the shell, so the
 *  keys are the same everywhere. */
export const terminalKeys = (accel: string, platform: Platform = platformNow()): string => {
  const p = parse(accel, platform);
  if (!p) return accel;
  if (platform !== "macos" && p.mods.has("Primary") && !p.mods.has("Shift") && /^[A-Z]$/.test(p.key)) p.mods.add("Shift");
  return write(p);
};

/** Where a shortcut is pressed: anywhere in Desk, or in a terminal pane. */
type Place = "desk" | "terminal";

/** Shortcut `id`'s keys in each place: one that works from any app has the
 *  same keys in a terminal. */
const keysByPlace = (id: ShortcutId, accel: string, platform: Platform): Record<Place, string | null> => {
  const desk = normalize(accel, platform);
  return { desk, terminal: desk && !isGlobal(id) ? terminalKeys(desk, platform) : desk };
};

const modifierLabels = (mods: Set<Modifier>, platform: Platform): string[] =>
  MODIFIER_LABELS[platform].filter(([m]) => mods.has(m)).map(([, label]) => label);

/** How the system shows a shortcut: "⌃⇧Space" on macOS, "Ctrl+Shift+Space"
 *  elsewhere. */
export const shortcutLabel = (accel: string, platform: Platform = platformNow()): string => {
  const p = parse(accel, platform);
  if (!p) return accel;
  const key = PUNCTUATION[p.key] ?? KEY_LABELS[platform][p.key] ?? p.key;
  const parts = [...modifierLabels(p.mods, platform), key];
  return platform === "macos" ? parts.join("") : parts.join("+");
};

/** What each system keeps for itself, and what for. Desk can't have these:
 *  the system takes the keys first, usually without Desk hearing of it. */
const RESERVED: Record<Platform, [string, string][]> = {
  macos: [
    ["Super+Space", "Spotlight"],
    ["Alt+Super+Space", "the Finder search window"],
    ["Control+Space", "switching input sources"],
    ["Control+Alt+Space", "switching input sources"],
    ["Control+Super+Space", "the emoji picker"],
    ["Shift+Super+3", "screenshots"],
    ["Shift+Super+4", "screenshots"],
    ["Shift+Super+5", "screenshots"],
    ["Shift+Super+6", "screenshots"],
    ["Control+Shift+Super+3", "screenshots"],
    ["Control+Shift+Super+4", "screenshots"],
    ["Super+Tab", "switching apps"],
    ["Shift+Super+Tab", "switching apps"],
    ["Super+Backquote", "switching windows"],
    ["Alt+Super+Escape", "Force Quit"],
    ["Control+Super+Q", "locking the screen"],
    ["Shift+Super+Q", "logging out"],
    ["Shift+Super+Slash", "the Help menu"],
    ["Control+Up", "Mission Control"],
    ["Control+Down", "App Exposé"],
    ["Control+Left", "moving between desktops"],
    ["Control+Right", "moving between desktops"],
  ],
  windows: [
    ["Super+L", "locking the screen"],
    ["Super+D", "showing the desktop"],
    ["Super+E", "File Explorer"],
    ["Super+R", "Run"],
    ["Super+I", "Settings"],
    ["Super+V", "clipboard history"],
    ["Super+X", "the quick link menu"],
    ["Super+Tab", "Task View"],
    ["Super+Space", "switching input languages"],
    ["Super+Period", "the emoji picker"],
    ["Shift+Super+S", "screenshots"],
    ["Alt+Tab", "switching apps"],
    ["Shift+Alt+Tab", "switching apps"],
    ["Alt+F4", "closing windows"],
    ["Control+Alt+Delete", "security options"],
    ["Control+Shift+Escape", "Task Manager"],
    ["Control+Escape", "the Start menu"],
  ],
  linux: [
    ["Super+Space", "switching input sources"],
    ["Super+L", "locking the screen"],
    ["Super+A", "the app list"],
    ["Super+Tab", "switching apps"],
    ["Alt+Tab", "switching apps"],
    ["Shift+Alt+Tab", "switching apps"],
    ["Alt+F2", "running a command"],
    ["Alt+F4", "closing windows"],
    ["Control+Alt+T", "opening a terminal"],
    ["Control+Alt+Delete", "logging out"],
    ["Control+Alt+Left", "moving between workspaces"],
    ["Control+Alt+Right", "moving between workspaces"],
  ],
};

/** What the system is called when it has the keys. */
const SYSTEM: Record<Platform, string> = { macos: "macOS", windows: "Windows", linux: "Your desktop" };

/** What Desk's menu (macOS) or every text field (elsewhere) does with
 *  keys: they come before any shortcut of Desk's could. */
const MENU: Record<Platform, [string, string][]> = {
  macos: [
    ["Super+Q", "Quit"],
    ["Super+H", "Hide"],
    ["Alt+Super+H", "Hide Others"],
    ["Super+W", "Close Window"],
    ["Super+M", "Minimize"],
    ["Super+Z", "Undo"],
    ["Shift+Super+Z", "Redo"],
    ["Super+X", "Cut"],
    ["Super+C", "Copy"],
    ["Super+V", "Paste"],
    ["Super+A", "Select All"],
    ["Control+Super+F", "Full Screen"],
  ],
  windows: [
    ["Control+Z", "Undo"],
    ["Control+Y", "Redo"],
    ["Control+X", "Cut"],
    ["Control+C", "Copy"],
    ["Control+V", "Paste"],
    ["Control+A", "Select All"],
  ],
  linux: [
    ["Control+Z", "Undo"],
    ["Shift+Control+Z", "Redo"],
    ["Control+X", "Cut"],
    ["Control+C", "Copy"],
    ["Control+V", "Paste"],
    ["Control+A", "Select All"],
  ],
};

const lookup = (table: [string, string][], platform: Platform): Map<string, string> =>
  new Map(table.map(([accel, what]) => [normalize(accel, platform)!, what]));

/** Keys other apps commonly take for themselves. Desk lets you choose them,
 *  and says they may never reach it. */
const COMMON: [string, string][] = [["Alt+Space", "Launchers like Raycast, Alfred, ChatGPT and Claude"]];

/** What to add for a shortcut that needs another modifier, as the system
 *  shows them. */
const ADD: Record<Platform, { app: string; global: string; beyondPrimary: string }> = {
  macos: { app: "⌘ or ⌃", global: "⌃, ⌥ or ⌘", beyondPrimary: "⌃, ⌥ or ⇧" },
  windows: { app: "Ctrl", global: "Ctrl, Alt or Win", beyondPrimary: "Alt or Shift" },
  linux: { app: "Ctrl", global: "Ctrl, Alt or Super", beyondPrimary: "Alt or Shift" },
};

/** Why a shortcut can't be Desk's, in plain words; null when it can. A
 *  global one mustn't be a key the system or an app uses for itself; one
 *  that works only in Desk needs the command key (or ⌃ on macOS) so it
 *  doesn't stop you typing. */
export const refusal = (accel: string, scope: Scope = "global", platform: Platform = platformNow()): string | null => {
  const p = parse(accel, platform);
  if (!p) return "Desk can’t use that key — choose another";
  const label = shortcutLabel(accel, platform);
  const keys = write(p);
  const what = lookup(RESERVED[platform], platform).get(keys);
  if (what) return `${SYSTEM[platform]} uses ${label} for ${what} — choose another`;
  const fKey = /^F\d+$/.test(p.key);
  const add = ADD[platform];
  if (scope === "app") {
    if (!p.mods.has("Primary") && !p.mods.has("Control") && !fKey) return `${label} would stop you typing — add ${add.app}`;
  } else {
    if ([...p.mods].every((m) => m === "Shift") && !fKey) return `${label} would stop you typing it — add ${add.global}`;
    if (p.mods.size === 1 && p.mods.has("Primary") && !fKey) return `${label} belongs to whichever app you’re in — add ${add.beyondPrimary}`;
  }
  const menu = lookup(MENU[platform], platform).get(keys);
  if (menu) return `${label} is ${menu} — choose another`;
  return null;
};

/** A word of caution about keys Desk can have but another app often takes
 *  first; null when there's none. */
export const warning = (accel: string, platform: Platform = platformNow()): string | null => {
  const n = normalize(accel, platform);
  const who = n ? lookup(COMMON, platform).get(n) : undefined;
  return who ? `${who} often use ${shortcutLabel(accel, platform)} — if nothing happens, choose another` : null;
};

/** Each shortcut's default keys on `platform`, written as Desk writes them. */
export const defaultShortcuts = (platform: Platform = platformNow()): Record<ShortcutId, string> =>
  Object.fromEntries(SHORTCUTS.map((s) => [s.id, normalize(s.keys, platform)!])) as Record<ShortcutId, string>;

/** The shortcut to use for a stored value: the default when there's none,
 *  Desk can't read it, or it can't be Desk's. */
export const usable = (stored: string | undefined | null, id: ShortcutId, platform: Platform = platformNow()): string => {
  const n = stored ? normalize(stored, platform) : null;
  return n && !refusal(n, scopeOf(id), platform) ? n : defaultShortcuts(platform)[id];
};

/** Why `accel` can't be `id`'s when Desk's shortcuts are `keys`: another
 *  of Desk's own already has it. */
export const clash = (keys: Record<ShortcutId, string>, id: ShortcutId, accel: string, platform: Platform = platformNow()): string | null => {
  const mine = keysByPlace(id, accel, platform);
  const others = SHORTCUT_IDS.filter((o) => o !== id).map((o) => [o, keysByPlace(o, keys[o], platform)] as const);
  const other = others.find(([, k]) => k.desk === mine.desk)?.[0];
  if (other) return `${shortcutLabel(accel, platform)} is already ${SHORTCUT_NAMES[other]} — choose another`;
  const inTerminal = others.find(([, k]) => k.terminal === mine.terminal)?.[0];
  return inTerminal
    ? `In a terminal, ${shortcutLabel(mine.terminal!, platform)} is already ${SHORTCUT_NAMES[inTerminal]} — choose another`
    : null;
};

/** Desk's shortcuts from the chosen ones (saved by id, only where they
 *  differ from the default): each one's keys, and the choices that still
 *  stand, written as Desk writes them now — so `Super+J` saved on macOS
 *  before `Primary` is kept as `Primary+J`, and one that now equals its
 *  default is dropped. A choice Desk can't use, or that has keys another
 *  shortcut has, is dropped for the default; ids a newer Desk saved are
 *  kept as they are. */
export const resolve = (
  chosen: Record<string, string>,
  platform: Platform = platformNow(),
): { keys: Record<ShortcutId, string>; chosen: Record<string, string> } => {
  const defaults = defaultShortcuts(platform);
  const kept: Record<string, string> = {};
  for (const [id, accel] of Object.entries(chosen)) {
    if (!isShortcutId(id)) kept[id] = accel;
    else if (usable(accel, id, platform) !== defaults[id]) kept[id] = usable(accel, id, platform);
  }
  const keysOf = (): Record<ShortcutId, string> =>
    Object.fromEntries(SHORTCUT_IDS.map((id) => [id, kept[id] ?? defaults[id]])) as Record<ShortcutId, string>;
  // Defaults never clash with each other, in Desk or in a terminal, so
  // dropping choices one at a time — the later of two choices, or a choice
  // over a default — ends clean.
  for (;;) {
    const keys = keysOf();
    const seen = new Map<string, ShortcutId>();
    let drop: ShortcutId | null = null;
    for (const id of SHORTCUT_IDS) {
      const places = Object.entries(keysByPlace(id, keys[id], platform)).map(([place, k]) => `${place} ${k}`);
      const first = places.map((p) => seen.get(p)).find((o) => o !== undefined);
      if (first === undefined) {
        for (const p of places) seen.set(p, id);
        continue;
      }
      drop = kept[id] !== undefined ? id : first;
      break;
    }
    if (!drop) return { keys, chosen: kept };
    delete kept[drop];
  }
};

/** The chosen shortcuts with `id` set to `accel`; the default isn't saved,
 *  so it follows Desk's default if that ever changes. */
export const choose = (
  chosen: Record<string, string>,
  id: ShortcutId,
  accel: string,
  platform: Platform = platformNow(),
): Record<string, string> => {
  const rest = { ...chosen };
  delete rest[id];
  const n = normalize(accel, platform) ?? accel;
  return n === defaultShortcuts(platform)[id] ? rest : { ...rest, [id]: n };
};

export interface KeyPress {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$|^CapsLock$|^Fn$/;

/** What a key press in the recorder means: only modifiers held so far, a
 *  whole shortcut, or a key Desk can't use. */
export type Pressed = { kind: "modifiers"; label: string } | { kind: "shortcut"; accel: string } | { kind: "unknown" };

export const pressed = (e: KeyPress, platform: Platform = platformNow()): Pressed => {
  const held = new Set<Modifier>();
  if (e.ctrlKey) held.add("Control");
  if (e.altKey) held.add("Alt");
  if (e.shiftKey) held.add("Shift");
  if (e.metaKey) held.add("Super");
  const mods = new Set<Modifier>([...held].map((m) => (m === PRIMARY[platform] ? "Primary" : m)));
  if (MODIFIER_CODES.test(e.code)) {
    const labels = modifierLabels(mods, platform);
    return { kind: "modifiers", label: platform === "macos" ? labels.join("") : labels.join("+") };
  }
  const key = KEYS[e.code];
  return key ? { kind: "shortcut", accel: write({ mods, key }) } : { kind: "unknown" };
};

/** Whether a key press is the shortcut `accel`, by where the keys are. */
export const matches = (e: KeyPress, accel: string, platform: Platform = platformNow()): boolean => {
  const p = pressed(e, platform);
  return p.kind === "shortcut" && p.accel === normalize(accel, platform);
};
