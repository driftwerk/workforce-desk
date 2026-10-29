import { describe, expect, it } from "vitest";
import { choose, clash, DEFAULT_SHORTCUTS, matches, normalize, pressed, refusal, resolve, shortcutLabel, usable, warning } from "./keys";

const press = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) =>
  pressed({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe("shortcut keys", () => {
  it("defaults to keys macOS and the common launchers leave free", () => {
    expect(DEFAULT_SHORTCUTS).toEqual({
      ask: "Control+Shift+K",
      pushToTalk: "Control+Shift+Space",
      newSession: "Super+N",
      settings: "Super+Comma",
      saveFile: "Super+S",
    });
    expect(refusal(DEFAULT_SHORTCUTS.pushToTalk)).toBeNull();
    expect(refusal(DEFAULT_SHORTCUTS.ask)).toBeNull();
    expect(warning(DEFAULT_SHORTCUTS.ask)).toBeNull();
    for (const id of ["newSession", "settings", "saveFile"] as const) expect(refusal(DEFAULT_SHORTCUTS[id], "app")).toBeNull();
    expect(new Set(Object.values(DEFAULT_SHORTCUTS)).size).toBe(5);
  });

  it("warns about ⌥Space, which launchers take, without refusing it", () => {
    expect(refusal("Alt+Space")).toBeNull();
    expect(warning("Alt+Space")).toBe("Launchers like Raycast, Alfred, ChatGPT and Claude often use ⌥Space — if nothing happens, choose another");
    expect(usable("Alt+Space", "ask")).toBe("Alt+Space");
  });

  it("lets a shortcut in Desk be ⌘ and a key, but not what Desk's menu or typing needs", () => {
    expect(refusal("Super+J", "app")).toBeNull();
    expect(refusal("Super+C", "app")).toBe("⌘C is Copy — choose another");
    expect(refusal("Super+Q", "app")).toBe("⌘Q is Quit — choose another");
    expect(refusal("Alt+K", "app")).toBe("⌥K would stop you typing — add ⌘ or ⌃");
    expect(refusal("Super+Space", "app")).toMatch(/Spotlight/);
    expect(usable("Super+J", "newSession")).toBe("Super+J");
    expect(usable("Super+V", "saveFile")).toBe("Super+S");
  });

  it("refuses another of Desk's shortcuts' keys, naming it", () => {
    expect(clash(DEFAULT_SHORTCUTS, "pushToTalk", "Shift+Control+K")).toBe("⌃⇧K is already Ask anyone — choose another");
    expect(clash(DEFAULT_SHORTCUTS, "ask", "Super+Comma")).toBe("⌘, is already Settings — choose another");
    expect(clash(DEFAULT_SHORTCUTS, "ask", "Control+Shift+K")).toBeNull();
    expect(clash(DEFAULT_SHORTCUTS, "ask", "Control+Alt+K")).toBeNull();
  });

  it("saves only the shortcuts that differ from their defaults", () => {
    expect(choose({}, "ask", "alt+space")).toEqual({ ask: "Alt+Space" });
    expect(choose({ ask: "Alt+Space", later: "x" }, "ask", "Control+Shift+K")).toEqual({ later: "x" });
  });

  it("drops chosen keys Desk can't use or another shortcut has, and keeps a newer Desk's", () => {
    expect(resolve({}).keys).toEqual(DEFAULT_SHORTCUTS);
    expect(resolve({ ask: "Alt+Space", newSession: "Super+C", saveFile: "Nope", later: "Control+Alt+L" })).toEqual({
      keys: { ...DEFAULT_SHORTCUTS, ask: "Alt+Space" },
      chosen: { ask: "Alt+Space", later: "Control+Alt+L" },
    });
    // A choice over another's default gives way; of two equal choices, the later.
    expect(resolve({ pushToTalk: "Control+Shift+K" }).keys.pushToTalk).toBe("Control+Shift+Space");
    expect(resolve({ ask: "Control+Alt+J", pushToTalk: "Control+Alt+J" }).chosen).toEqual({ ask: "Control+Alt+J" });
  });

  it("knows a key press by where the keys are", () => {
    const e = { code: "Comma", key: "≤", ctrlKey: false, altKey: false, shiftKey: false, metaKey: true };
    expect(matches(e, "Super+Comma")).toBe(true);
    expect(matches({ ...e, shiftKey: true }, "Super+Comma")).toBe(false);
    expect(matches(e, "Super+N")).toBe(false);
  });

  it("shows shortcuts the macOS way, modifiers in Apple's order", () => {
    expect(shortcutLabel("Control+Shift+Space")).toBe("⌃⇧Space");
    expect(shortcutLabel("Alt+Space")).toBe("⌥Space");
    expect(shortcutLabel("Super+Shift+Alt+Control+K")).toBe("⌃⌥⇧⌘K");
    expect(shortcutLabel("Control+Alt+Up")).toBe("⌃⌥↑");
    expect(shortcutLabel("Control+Alt+Comma")).toBe("⌃⌥,");
    expect(shortcutLabel("Alt+F5")).toBe("⌥F5");
  });

  it("writes every spelling of a shortcut one way", () => {
    expect(normalize("Shift+Ctrl+space")).toBe("Control+Shift+Space");
    expect(normalize("Cmd+Option+KeyK")).toBe("Alt+Super+K");
    expect(normalize("Control+Nope")).toBeNull();
    expect(normalize("Control+K+J")).toBeNull();
  });

  it("refuses what macOS keeps, saying what for", () => {
    expect(refusal("Alt+Super+Space")).toBe("macOS uses ⌥⌘Space for the Finder search window — choose another");
    expect(refusal("Super+Space")).toBe("macOS uses ⌘Space for Spotlight — choose another");
    expect(refusal("Control+Space")).toMatch(/input sources/);
    expect(refusal("Alt+Control+Space")).toMatch(/input sources/);
    expect(refusal("Control+Super+Space")).toMatch(/emoji/);
    expect(refusal("Super+Shift+4")).toMatch(/screenshots/);
  });

  it("refuses keys that would stop typing or steal an app's own commands", () => {
    expect(refusal("K")).toBe("K would stop you typing it — add ⌃, ⌥ or ⌘");
    expect(refusal("Shift+K")).toMatch(/typing/);
    expect(refusal("Super+C")).toBe("⌘C belongs to whichever app you’re in — add ⌃, ⌥ or ⇧");
    expect(refusal("F5")).toBeNull();
    expect(refusal("Control+Alt+K")).toBeNull();
  });

  it("falls back to the default for a missing, unreadable or reserved value", () => {
    expect(usable(undefined, "pushToTalk")).toBe("Control+Shift+Space");
    expect(usable("Control+Nope", "ask")).toBe("Control+Shift+K");
    expect(usable("Alt+Super+Space", "pushToTalk")).toBe("Control+Shift+Space");
    expect(usable("alt+ctrl+k", "pushToTalk")).toBe("Control+Alt+K");
  });

  it("reads a key press by where the key is, not what it types", () => {
    expect(press("ShiftLeft", { ctrlKey: true, shiftKey: true })).toEqual({ kind: "modifiers", label: "⌃⇧" });
    expect(press("Space", { ctrlKey: true, shiftKey: true })).toEqual({ kind: "shortcut", accel: "Control+Shift+Space" });
    expect(press("KeyA", { altKey: true })).toEqual({ kind: "shortcut", accel: "Alt+A" });
    expect(press("Digit1", { metaKey: true, ctrlKey: true })).toEqual({ kind: "shortcut", accel: "Control+Super+1" });
    expect(press("IntlRo", { ctrlKey: true })).toEqual({ kind: "unknown" });
  });
});
