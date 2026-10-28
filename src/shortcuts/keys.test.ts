import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUTS, normalize, pressed, refusal, shortcutLabel, usable } from "./keys";

const press = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) =>
  pressed({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe("shortcut keys", () => {
  it("defaults to keys macOS leaves free", () => {
    expect(DEFAULT_SHORTCUTS).toEqual({ pushToTalk: "Control+Shift+Space", ask: "Alt+Space" });
    expect(refusal(DEFAULT_SHORTCUTS.pushToTalk)).toBeNull();
    expect(refusal(DEFAULT_SHORTCUTS.ask)).toBeNull();
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
    expect(usable("Control+Nope", "ask")).toBe("Alt+Space");
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
