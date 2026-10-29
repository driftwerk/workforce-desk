/** Desk's keyboard shortcuts, written the way the global-shortcut plugin
 *  reads them ("Control+Shift+Space") and shown the way macOS does (⌃⇧Space).
 *  The global ones work from any app; the rest only while Desk is in front. */

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
  { id: "newSession", name: "New session", about: "Starts a new session.", keys: "Super+N", scope: "app" },
  {
    id: "newTerminal",
    name: "New terminal",
    about: "Opens a terminal in the grid you’re looking at: in its empty pane, or beside the one you’re in.",
    keys: "Super+T",
    scope: "app",
  },
  {
    id: "fillPane",
    name: "Fill the grid",
    about: "Gives the grid pane you’re in the whole grid for a while, and puts the grid back.",
    keys: "Shift+Super+Enter",
    scope: "app",
  },
  { id: "settings", name: "Settings", about: "Opens Settings, and goes back to your desk.", keys: "Super+Comma", scope: "app" },
  { id: "saveFile", name: "Save a file", about: "Saves the agent file you’re editing.", keys: "Super+S", scope: "app" },
] as const satisfies readonly ShortcutSpec[];

type Spec = (typeof SHORTCUTS)[number];
export type ShortcutId = Spec["id"];
export type GlobalShortcutId = Extract<Spec, { scope: "global" }>["id"];

export const SHORTCUT_IDS: ShortcutId[] = SHORTCUTS.map((s) => s.id);

const SPEC = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s])) as Record<ShortcutId, Spec>;

export const DEFAULT_SHORTCUTS = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.keys])) as Record<ShortcutId, string>;

export const SHORTCUT_NAMES = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.name])) as Record<ShortcutId, string>;

export const scopeOf = (id: ShortcutId): Scope => SPEC[id].scope;

export const isGlobal = (id: ShortcutId): id is GlobalShortcutId => scopeOf(id) === "global";

export const isShortcutId = (id: string): id is ShortcutId => id in SPEC;

/** In macOS's order: ⌃⌥⇧⌘. */
const MODIFIERS = ["Control", "Alt", "Shift", "Super"] as const;
type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_SYMBOL: Record<Modifier, string> = { Control: "⌃", Alt: "⌥", Shift: "⇧", Super: "⌘" };

const MODIFIER_ALIASES: Record<string, Modifier> = {
  CONTROL: "Control",
  CTRL: "Control",
  ALT: "Alt",
  OPTION: "Alt",
  SHIFT: "Shift",
  SUPER: "Super",
  CMD: "Super",
  COMMAND: "Super",
  META: "Super",
  COMMANDORCONTROL: "Super",
  CMDORCTRL: "Super",
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

const KEY_SYMBOL: Record<string, string> = {
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

interface Parsed {
  mods: Set<Modifier>;
  key: string;
}

const parse = (accel: string): Parsed | null => {
  const tokens = accel.split("+").map((t) => t.trim());
  const mods = new Set<Modifier>();
  let key: string | null = null;
  for (const t of tokens) {
    const mod = MODIFIER_ALIASES[t.toUpperCase()];
    if (mod && key === null) mods.add(mod);
    else if (key === null && KEY_NAMES.has(t.toUpperCase())) key = KEY_NAMES.get(t.toUpperCase())!;
    else return null;
  }
  return key ? { mods, key } : null;
};

const write = ({ mods, key }: Parsed): string => [...MODIFIERS.filter((m) => mods.has(m)), key].join("+");

/** The shortcut with its modifiers in one order, so equal ones compare
 *  equal; null for one Desk can't read. */
export const normalize = (accel: string): string | null => {
  const p = parse(accel);
  return p ? write(p) : null;
};

/** "Control+Shift+Space" as macOS shows it: "⌃⇧Space". */
export const shortcutLabel = (accel: string): string => {
  const p = parse(accel);
  if (!p) return accel;
  return MODIFIERS.filter((m) => p.mods.has(m))
    .map((m) => MODIFIER_SYMBOL[m])
    .concat(KEY_SYMBOL[p.key] ?? p.key)
    .join("");
};

/** What macOS keeps for itself, and what for. Desk can't have these: macOS
 *  takes the keys first, usually without Desk ever hearing about it. */
const RESERVED: [string, string][] = [
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
];
const RESERVED_BY = new Map(RESERVED.map(([accel, what]) => [normalize(accel)!, what]));

/** What Desk's own menu does with keys: the menu takes them before any
 *  shortcut of Desk's could. */
const MENU: [string, string][] = [
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
];
const MENU_BY = new Map(MENU.map(([accel, what]) => [normalize(accel)!, what]));

/** Keys other apps commonly take for themselves. Desk lets you choose them,
 *  and says they may never reach it. */
const COMMON: [string, string][] = [["Alt+Space", "Launchers like Raycast, Alfred, ChatGPT and Claude"]];
const COMMON_BY = new Map(COMMON.map(([accel, who]) => [normalize(accel)!, who]));

/** Why a shortcut can't be Desk's, in plain words; null when it can. A
 *  global one mustn't be a key an app uses for itself; one that works only
 *  in Desk needs ⌘ or ⌃ so it doesn't stop you typing. */
export const refusal = (accel: string, scope: Scope = "global"): string | null => {
  const p = parse(accel);
  if (!p) return "Desk can’t use that key — choose another";
  const label = shortcutLabel(accel);
  const keys = write(p);
  const what = RESERVED_BY.get(keys);
  if (what) return `macOS uses ${label} for ${what} — choose another`;
  const fKey = /^F\d+$/.test(p.key);
  if (scope === "app") {
    if (!p.mods.has("Control") && !p.mods.has("Super") && !fKey) return `${label} would stop you typing — add ⌘ or ⌃`;
  } else {
    if (!p.mods.has("Control") && !p.mods.has("Alt") && !p.mods.has("Super") && !fKey)
      return `${label} would stop you typing it — add ⌃, ⌥ or ⌘`;
    if (p.mods.size === 1 && p.mods.has("Super") && !fKey) return `${label} belongs to whichever app you’re in — add ⌃, ⌥ or ⇧`;
  }
  const menu = MENU_BY.get(keys);
  if (menu) return `${label} is ${menu} — choose another`;
  return null;
};

/** A word of caution about keys Desk can have but another app often takes
 *  first; null when there's none. */
export const warning = (accel: string): string | null => {
  const n = normalize(accel);
  const who = n ? COMMON_BY.get(n) : undefined;
  return who ? `${who} often use ${shortcutLabel(accel)} — if nothing happens, choose another` : null;
};

/** The shortcut to use for a stored value: the default when there's none,
 *  Desk can't read it, or it can't be Desk's. */
export const usable = (stored: string | undefined | null, id: ShortcutId): string => {
  const n = stored ? normalize(stored) : null;
  return n && !refusal(n, scopeOf(id)) ? n : DEFAULT_SHORTCUTS[id];
};

/** Why `accel` can't be `id`'s when Desk's shortcuts are `keys`: another
 *  of Desk's own already has it. */
export const clash = (keys: Record<ShortcutId, string>, id: ShortcutId, accel: string): string | null => {
  const n = normalize(accel);
  const other = SHORTCUT_IDS.find((o) => o !== id && normalize(keys[o]) === n);
  return other ? `${shortcutLabel(accel)} is already ${SHORTCUT_NAMES[other]} — choose another` : null;
};

/** Desk's shortcuts from the chosen ones (saved by id, only where they
 *  differ from the default): each one's keys, and the choices that still
 *  stand. A choice Desk can't use, or that has keys another shortcut has,
 *  is dropped for the default; ids a newer Desk saved are kept as they are. */
export const resolve = (chosen: Record<string, string>): { keys: Record<ShortcutId, string>; chosen: Record<string, string> } => {
  const kept: Record<string, string> = {};
  for (const [id, accel] of Object.entries(chosen)) {
    if (!isShortcutId(id)) kept[id] = accel;
    else if (usable(accel, id) !== DEFAULT_SHORTCUTS[id]) kept[id] = usable(accel, id);
  }
  const keysOf = (): Record<ShortcutId, string> =>
    Object.fromEntries(SHORTCUT_IDS.map((id) => [id, kept[id] ?? DEFAULT_SHORTCUTS[id]])) as Record<ShortcutId, string>;
  // Defaults never clash with each other, so dropping choices one at a time
  // — the later of two choices, or a choice over a default — ends clean.
  for (;;) {
    const keys = keysOf();
    const seen = new Map<string, ShortcutId>();
    let drop: ShortcutId | null = null;
    for (const id of SHORTCUT_IDS) {
      const first = seen.get(keys[id]);
      if (first === undefined) {
        seen.set(keys[id], id);
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
export const choose = (chosen: Record<string, string>, id: ShortcutId, accel: string): Record<string, string> => {
  const rest = { ...chosen };
  delete rest[id];
  const n = normalize(accel) ?? accel;
  return n === DEFAULT_SHORTCUTS[id] ? rest : { ...rest, [id]: n };
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

export const pressed = (e: KeyPress): Pressed => {
  const mods = new Set<Modifier>();
  if (e.ctrlKey) mods.add("Control");
  if (e.altKey) mods.add("Alt");
  if (e.shiftKey) mods.add("Shift");
  if (e.metaKey) mods.add("Super");
  if (MODIFIER_CODES.test(e.code))
    return { kind: "modifiers", label: MODIFIERS.filter((m) => mods.has(m)).map((m) => MODIFIER_SYMBOL[m]).join("") };
  const key = KEYS[e.code];
  return key ? { kind: "shortcut", accel: write({ mods, key }) } : { kind: "unknown" };
};

/** Whether a key press is the shortcut `accel`, by where the keys are. */
export const matches = (e: KeyPress, accel: string): boolean => {
  const p = pressed(e);
  return p.kind === "shortcut" && p.accel === normalize(accel);
};
