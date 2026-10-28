/** Desk's two global shortcuts, written the way the global-shortcut plugin
 *  reads them ("Control+Shift+Space") and shown the way macOS does (⌃⇧Space). */

export type ShortcutId = "pushToTalk" | "ask";

/** Hold to talk, release to send; and open "Ask anyone" from any app. */
export const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = {
  pushToTalk: "Control+Shift+Space",
  ask: "Alt+Space",
};

export const SHORTCUT_NAMES: Record<ShortcutId, string> = {
  pushToTalk: "Hold to talk",
  ask: "Ask anyone",
};

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

/** Why a shortcut can't be Desk's, in plain words; null when it can. */
export const refusal = (accel: string): string | null => {
  const p = parse(accel);
  if (!p) return "Desk can’t use that key — choose another";
  const label = shortcutLabel(accel);
  const what = RESERVED_BY.get(write(p));
  if (what) return `macOS uses ${label} for ${what} — choose another`;
  const fKey = /^F\d+$/.test(p.key);
  if (!p.mods.has("Control") && !p.mods.has("Alt") && !p.mods.has("Super") && !fKey)
    return `${label} would stop you typing it — add ⌃, ⌥ or ⌘`;
  if (p.mods.size === 1 && p.mods.has("Super") && !fKey) return `${label} belongs to whichever app you’re in — add ⌃, ⌥ or ⇧`;
  return null;
};

/** The shortcut to use for a stored value: the default when there's none,
 *  Desk can't read it, or macOS keeps it. */
export const usable = (stored: string | undefined | null, id: ShortcutId): string => {
  const n = stored ? normalize(stored) : null;
  return n && !refusal(n) ? n : DEFAULT_SHORTCUTS[id];
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
