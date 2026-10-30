import { describe, expect, it } from "vitest";
import {
  choose,
  clash,
  defaultShortcuts,
  matches,
  normalize,
  pluginKeys,
  pressed,
  refusal,
  resolve,
  SHORTCUT_IDS,
  shortcutLabel,
  terminalKeys,
  usable,
  warning,
  type KeyPress,
} from "./keys";

const press = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}): KeyPress => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

const MAC = defaultShortcuts("macos");

describe("shortcut keys on macOS", () => {
  it("defaults to keys macOS and the common launchers leave free", () => {
    expect(MAC).toEqual({
      ask: "Control+Shift+K",
      pushToTalk: "Control+Shift+Space",
      newSession: "Primary+N",
      newTerminal: "Primary+T",
      fillPane: "Primary+Shift+Enter",
      settings: "Primary+Comma",
      saveFile: "Primary+S",
      stopAnswer: "Primary+Period",
      jumpNew: "Primary+J",
      searchRoom: "Primary+F",
      searchRooms: "Primary+Shift+F",
      unread: "Primary+Shift+U",
    });
    expect(refusal(MAC.pushToTalk, "global", "macos")).toBeNull();
    expect(refusal(MAC.ask, "global", "macos")).toBeNull();
    expect(warning(MAC.ask, "macos")).toBeNull();
    for (const id of ["newSession", "newTerminal", "fillPane", "settings", "saveFile", "stopAnswer", "jumpNew", "searchRoom", "searchRooms", "unread"] as const) expect(refusal(MAC[id], "app", "macos")).toBeNull();
    expect(new Set(Object.values(MAC)).size).toBe(Object.keys(MAC).length);
  });

  it("warns about ⌥Space, which launchers take, without refusing it", () => {
    expect(refusal("Alt+Space", "global", "macos")).toBeNull();
    expect(warning("Alt+Space", "macos")).toBe("Launchers like Raycast, Alfred, ChatGPT and Claude often use ⌥Space — if nothing happens, choose another");
    expect(usable("Alt+Space", "ask", "macos")).toBe("Alt+Space");
  });

  it("lets a shortcut in Desk be ⌘ and a key, but not what Desk's menu or typing needs", () => {
    expect(refusal("Super+J", "app", "macos")).toBeNull();
    expect(refusal("Super+C", "app", "macos")).toBe("⌘C is Copy — choose another");
    expect(refusal("Super+Q", "app", "macos")).toBe("⌘Q is Quit — choose another");
    expect(refusal("Alt+K", "app", "macos")).toBe("⌥K would stop you typing — add ⌘ or ⌃");
    expect(refusal("Super+Space", "app", "macos")).toMatch(/Spotlight/);
    expect(usable("Super+J", "newSession", "macos")).toBe("Primary+J");
    expect(usable("Super+V", "saveFile", "macos")).toBe("Primary+S");
  });

  it("refuses another of Desk's shortcuts' keys, naming it", () => {
    expect(clash(MAC, "pushToTalk", "Shift+Control+K", "macos")).toBe("⌃⇧K is already Ask anyone — choose another");
    expect(clash(MAC, "ask", "Super+Comma", "macos")).toBe("⌘, is already Settings — choose another");
    expect(clash(MAC, "ask", "Control+Shift+K", "macos")).toBeNull();
    expect(clash(MAC, "ask", "Control+Alt+K", "macos")).toBeNull();
  });

  it("saves only the shortcuts that differ from their defaults", () => {
    expect(choose({}, "ask", "alt+space", "macos")).toEqual({ ask: "Alt+Space" });
    expect(choose({ ask: "Alt+Space", later: "x" }, "ask", "Control+Shift+K", "macos")).toEqual({ later: "x" });
    expect(choose({}, "newSession", "Super+N", "macos")).toEqual({});
  });

  it("drops chosen keys Desk can't use or another shortcut has, and keeps a newer Desk's", () => {
    expect(resolve({}, "macos").keys).toEqual(MAC);
    expect(resolve({ ask: "Alt+Space", newSession: "Super+C", saveFile: "Nope", later: "Control+Alt+L" }, "macos")).toEqual({
      keys: { ...MAC, ask: "Alt+Space" },
      chosen: { ask: "Alt+Space", later: "Control+Alt+L" },
    });
    // A choice over another's default gives way; of two equal choices, the later.
    expect(resolve({ pushToTalk: "Control+Shift+K" }, "macos").keys.pushToTalk).toBe("Control+Shift+Space");
    expect(resolve({ ask: "Control+Alt+J", pushToTalk: "Control+Alt+J" }, "macos").chosen).toEqual({ ask: "Control+Alt+J" });
  });

  it("moves ⌘ saved before Primary over to it once", () => {
    expect(resolve({ newSession: "Super+Y", fillPane: "Shift+Super+Enter" }, "macos")).toEqual({
      keys: { ...MAC, newSession: "Primary+Y" },
      chosen: { newSession: "Primary+Y" },
    });
  });

  it("knows a key press by where the keys are", () => {
    const e = { code: "Comma", key: "≤", ctrlKey: false, altKey: false, shiftKey: false, metaKey: true };
    expect(matches(e, "Primary+Comma", "macos")).toBe(true);
    expect(matches(e, "Super+Comma", "macos")).toBe(true);
    expect(matches({ ...e, shiftKey: true }, "Primary+Comma", "macos")).toBe(false);
    expect(matches(e, "Primary+N", "macos")).toBe(false);
  });

  it("shows shortcuts the macOS way, modifiers in Apple's order", () => {
    expect(shortcutLabel("Control+Shift+Space", "macos")).toBe("⌃⇧Space");
    expect(shortcutLabel("Alt+Space", "macos")).toBe("⌥Space");
    expect(shortcutLabel("Super+Shift+Alt+Control+K", "macos")).toBe("⌃⌥⇧⌘K");
    expect(shortcutLabel("Primary+Shift+Enter", "macos")).toBe("⇧⌘↩");
    expect(shortcutLabel("Control+Alt+Up", "macos")).toBe("⌃⌥↑");
    expect(shortcutLabel("Control+Alt+Comma", "macos")).toBe("⌃⌥,");
    expect(shortcutLabel("Alt+F5", "macos")).toBe("⌥F5");
  });

  it("writes every spelling of a shortcut one way", () => {
    expect(normalize("Shift+Ctrl+space", "macos")).toBe("Control+Shift+Space");
    expect(normalize("Cmd+Option+KeyK", "macos")).toBe("Primary+Alt+K");
    expect(normalize("CommandOrControl+K", "macos")).toBe("Primary+K");
    expect(normalize("Control+Nope", "macos")).toBeNull();
    expect(normalize("Control+K+J", "macos")).toBeNull();
  });

  it("refuses what macOS keeps, saying what for", () => {
    expect(refusal("Alt+Super+Space", "global", "macos")).toBe("macOS uses ⌥⌘Space for the Finder search window — choose another");
    expect(refusal("Super+Space", "global", "macos")).toBe("macOS uses ⌘Space for Spotlight — choose another");
    expect(refusal("Control+Space", "global", "macos")).toMatch(/input sources/);
    expect(refusal("Alt+Control+Space", "global", "macos")).toMatch(/input sources/);
    expect(refusal("Control+Super+Space", "global", "macos")).toMatch(/emoji/);
    expect(refusal("Super+Shift+4", "global", "macos")).toMatch(/screenshots/);
  });

  it("refuses keys that would stop typing or steal an app's own commands", () => {
    expect(refusal("K", "global", "macos")).toBe("K would stop you typing it — add ⌃, ⌥ or ⌘");
    expect(refusal("Shift+K", "global", "macos")).toMatch(/typing/);
    expect(refusal("Super+C", "global", "macos")).toBe("⌘C belongs to whichever app you’re in — add ⌃, ⌥ or ⇧");
    expect(refusal("F5", "global", "macos")).toBeNull();
    expect(refusal("Control+Alt+K", "global", "macos")).toBeNull();
  });

  it("falls back to the default for a missing, unreadable or reserved value", () => {
    expect(usable(undefined, "pushToTalk", "macos")).toBe("Control+Shift+Space");
    expect(usable("Control+Nope", "ask", "macos")).toBe("Control+Shift+K");
    expect(usable("Alt+Super+Space", "pushToTalk", "macos")).toBe("Control+Shift+Space");
    expect(usable("alt+ctrl+k", "pushToTalk", "macos")).toBe("Control+Alt+K");
  });

  it("reads a key press by where the key is, not what it types", () => {
    expect(pressed(press("ShiftLeft", { ctrlKey: true, shiftKey: true }), "macos")).toEqual({ kind: "modifiers", label: "⌃⇧" });
    expect(pressed(press("Space", { ctrlKey: true, shiftKey: true }), "macos")).toEqual({ kind: "shortcut", accel: "Control+Shift+Space" });
    expect(pressed(press("KeyA", { altKey: true }), "macos")).toEqual({ kind: "shortcut", accel: "Alt+A" });
    expect(pressed(press("Digit1", { metaKey: true, ctrlKey: true }), "macos")).toEqual({ kind: "shortcut", accel: "Primary+Control+1" });
    expect(pressed(press("IntlRo", { ctrlKey: true }), "macos")).toEqual({ kind: "unknown" });
  });

  it("hands the plugin ⌘ as Super", () => {
    expect(pluginKeys("Primary+Shift+K", "macos")).toBe("Super+Shift+K");
    expect(pluginKeys("Control+Shift+Space", "macos")).toBe("Control+Shift+Space");
  });
});

describe("shortcut keys on Windows and Linux", () => {
  const WIN = defaultShortcuts("windows");

  it("default to Ctrl where macOS has ⌘, and the same keys where macOS has ⌃", () => {
    expect(WIN).toEqual({
      ask: "Primary+Shift+K",
      pushToTalk: "Primary+Shift+Space",
      newSession: "Primary+N",
      newTerminal: "Primary+T",
      fillPane: "Primary+Shift+Enter",
      settings: "Primary+Comma",
      saveFile: "Primary+S",
      stopAnswer: "Primary+Period",
      jumpNew: "Primary+J",
      unread: "Primary+Shift+U",
    });
    expect(defaultShortcuts("linux")).toEqual(WIN);
    for (const platform of ["windows", "linux"] as const) {
      const d = defaultShortcuts(platform);
      expect(refusal(d.ask, "global", platform)).toBeNull();
      expect(refusal(d.pushToTalk, "global", platform)).toBeNull();
      for (const id of ["newSession", "newTerminal", "fillPane", "settings", "saveFile", "stopAnswer", "jumpNew", "unread"] as const) expect(refusal(d[id], "app", platform)).toBeNull();
      expect(new Set(Object.values(d)).size).toBe(Object.keys(d).length);
    }
  });

  it("are shown with words, joined by +", () => {
    expect(shortcutLabel("Primary+Shift+Space", "windows")).toBe("Ctrl+Shift+Space");
    expect(shortcutLabel("Control+Alt+Up", "linux")).toBe("Ctrl+Alt+Up");
    expect(shortcutLabel("Super+Escape", "windows")).toBe("Win+Esc");
    expect(shortcutLabel("Super+Escape", "linux")).toBe("Super+Esc");
    expect(shortcutLabel("Primary+Comma", "linux")).toBe("Ctrl+,");
    expect(pressed(press("ControlLeft", { ctrlKey: true, altKey: true }), "windows")).toEqual({ kind: "modifiers", label: "Ctrl+Alt" });
  });

  it("read Ctrl as the command key, and give it to the plugin as Control", () => {
    expect(pressed(press("KeyN", { ctrlKey: true }), "windows")).toEqual({ kind: "shortcut", accel: "Primary+N" });
    expect(pressed(press("KeyN", { metaKey: true }), "linux")).toEqual({ kind: "shortcut", accel: "Super+N" });
    expect(matches(press("KeyN", { ctrlKey: true }), "Primary+N", "linux")).toBe(true);
    expect(matches(press("KeyN", { metaKey: true }), "Primary+N", "linux")).toBe(false);
    expect(pluginKeys("Primary+Shift+K", "windows")).toBe("Control+Shift+K");
  });

  it("refuse what Windows keeps, and the keys text fields need", () => {
    expect(refusal("Super+L", "global", "windows")).toBe("Windows uses Win+L for locking the screen — choose another");
    expect(refusal("Alt+Tab", "global", "windows")).toMatch(/switching apps/);
    expect(refusal("Control+Alt+Delete", "global", "windows")).toMatch(/security options/);
    expect(refusal("Control+C", "app", "windows")).toBe("Ctrl+C is Copy — choose another");
    expect(refusal("Alt+K", "app", "windows")).toBe("Alt+K would stop you typing — add Ctrl");
    expect(refusal("Control+K", "global", "windows")).toBe("Ctrl+K belongs to whichever app you’re in — add Alt or Shift");
    expect(refusal("K", "global", "windows")).toBe("K would stop you typing it — add Ctrl, Alt or Win");
  });

  it("refuse what a Linux desktop keeps", () => {
    expect(refusal("Control+Alt+T", "global", "linux")).toBe("Your desktop uses Ctrl+Alt+T for opening a terminal — choose another");
    expect(refusal("Super+Space", "global", "linux")).toMatch(/input sources/);
    expect(refusal("Shift+Control+Z", "app", "linux")).toBe("Ctrl+Shift+Z is Redo — choose another");
  });

  it("leave Ctrl and a letter to a terminal's shell, and take Ctrl+Shift there instead", () => {
    for (const platform of ["windows", "linux"] as const) {
      const d = defaultShortcuts(platform);
      expect(terminalKeys(d.newSession, platform)).toBe("Primary+Shift+N");
      expect(terminalKeys(d.newTerminal, platform)).toBe("Primary+Shift+T");
      expect(terminalKeys(d.saveFile, platform)).toBe("Primary+Shift+S");
      expect(terminalKeys(d.fillPane, platform)).toBe("Primary+Shift+Enter");
      expect(terminalKeys(d.settings, platform)).toBe("Primary+Comma");
      expect(shortcutLabel(terminalKeys(d.newSession, platform), platform)).toBe("Ctrl+Shift+N");
      expect(matches(press("KeyN", { ctrlKey: true }), terminalKeys(d.newSession, platform), platform)).toBe(false);
      expect(matches(press("KeyN", { ctrlKey: true, shiftKey: true }), terminalKeys(d.newSession, platform), platform)).toBe(true);
      // Every default has keys of its own in a terminal too.
      expect(resolve({}, platform).keys).toEqual(d);
      for (const id of SHORTCUT_IDS) expect(clash(d, id, d[id], platform)).toBeNull();
    }
    expect(terminalKeys("Primary+N", "macos")).toBe("Primary+N");
    expect(terminalKeys("Control+Alt+J", "linux")).toBe("Primary+Alt+Shift+J");
  });

  it("refuse keys that would be another shortcut's in a terminal", () => {
    const d = defaultShortcuts("linux");
    expect(clash(d, "fillPane", "Control+Shift+T", "linux")).toBe("In a terminal, Ctrl+Shift+T is already New terminal — choose another");
    expect(clash(d, "newSession", "Control+K", "linux")).toBe("In a terminal, Ctrl+Shift+K is already Ask anyone — choose another");
    expect(clash(defaultShortcuts("macos"), "fillPane", "Shift+Super+T", "macos")).toBeNull();
    expect(resolve({ fillPane: "Control+Shift+T" }, "linux").chosen).toEqual({});
  });

  it("keep a Mac's ⌃ choice as Ctrl, the command key here", () => {
    expect(resolve({ ask: "Control+Alt+J" }, "linux").chosen).toEqual({ ask: "Primary+Alt+J" });
    expect(resolve({ ask: "Control+Shift+K" }, "windows").chosen).toEqual({});
  });
});
