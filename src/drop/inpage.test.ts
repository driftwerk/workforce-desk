// With the system's drag and drop on (dragDropEnabled), the webview's own
// HTML5 drag and drop no longer reaches the page: on Windows WebView2's
// drop target is replaced, and on macOS Tauri's handler answers every drag
// over the view itself. Desk's dragging within the page (the sidebar's
// groups, rooms and grids, a grid's panes) must therefore be pointer
// events, and every file drop go through drop/route.ts.

import { describe, expect, it } from "vitest";
import { PointerSensor } from "@dnd-kit/dom";
import mainConf from "../../src-tauri/tauri.conf.json";
import macConf from "../../src-tauri/tauri.macos.conf.json";
import linuxConf from "../../src-tauri/tauri.linux.conf.json";
import windowsConf from "../../src-tauri/tauri.windows.conf.json";
import gridWindows from "../../src-tauri/src/grid_windows.rs?raw";
import { SENSORS } from "../groups/rows";

const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../**/*.d.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("dragging within the page", () => {
  it("is by pointer alone in the sidebar's rows (dnd-kit's pointer sensor)", () => {
    expect(SENSORS).toEqual([PointerSensor]);
  });

  it("uses no HTML5 drag and drop: nothing is made draggable, nor reads a drag's data, but the browser preview's composer", () => {
    expect(Object.keys(sources)).toContain("../attachments/Compose.tsx");
    expect(Object.keys(sources)).toContain("../groups/SidebarGroups.tsx");
    const html5 = Object.entries(sources).filter(([file, text]) => {
      if (file === "../attachments/Compose.tsx") return false;
      return /\sdraggable(=\{true\}|="true"|\s*\/?>)|\.dataTransfer\b|addEventListener\("(drag|drop)/.test(text);
    });
    expect(html5.map(([f]) => f)).toEqual([]);
  });
});

describe("the system's drag and drop", () => {
  it("is on in the main window and in a grid's own", () => {
    expect(mainConf.app.windows[0]!.dragDropEnabled).toBe(true);
    expect(macConf.app.windows[0]!.dragDropEnabled).toBe(true);
    expect(gridWindows).not.toMatch(/disable_drag_drop_handler/);
  });

  it("gives the page no fs access to what's dropped: drops.rs alone decides what of a drop is read", () => {
    // tauri-plugin-fs otherwise adds every dropped file, and every dropped
    // folder recursively, to its scope for the page's fs permissions.
    expect(mainConf.plugins.fs.scopeDroppedPaths).toBe(false);
    for (const conf of [macConf, linuxConf, windowsConf] as { plugins?: { fs?: unknown } }[]) expect(conf.plugins?.fs).toBeUndefined();
  });
});
