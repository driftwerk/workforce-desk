// Files dragged in from the Finder (Explorer, a file manager), as the
// system's own drag and drop hands them to Desk (`onDragDropEvent`): with
// their paths, which a page's own drop never has, and where the pointer is.
// Each drop goes to what is under the pointer: a terminal's pane (which is
// given the paths), a conversation (which attaches the files), or nothing.
//
// What can take a drop marks its element `data-drop-zone="<id>"` and
// registers what it does with that id. The innermost under the pointer
// takes it; while files are dragged over one, `useDropOver` names it so it
// can show that it will.
//
// Dragging within the page (the sidebar's rows, a grid's panes) is done
// with pointer events, not HTML5 drag and drop, and never comes here.

import { create } from "zustand";
import type { Platform } from "../shell/host";

let native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Whether files arrive through the system's drag and drop (in the app),
 *  rather than the page's own (the browser preview). */
export const nativeDrops = (): boolean => native;

/** For tests: as the app (true) or the browser preview. */
export const setNativeDrops = (on: boolean): void => {
  native = on;
};

/** What a zone does with files dropped on it. */
export interface Zone {
  /** What it is ("session", "terminal", "conversation"). */
  label: string;
  drop: (paths: string[]) => void;
}

const zones = new Map<string, Zone>();

/** Makes `id` take drops, doing `zone`'s; answers how to stop. */
export const registerZone = (id: string, zone: Zone): (() => void) => {
  zones.set(id, zone);
  return () => {
    if (zones.get(id) === zone) zones.delete(id);
  };
};

/** Which zone is under files being dragged, if any. */
export const useDropOver = create<{ over: string | null }>(() => ({ over: null }));

/** The attribute a zone's element carries. */
export const ZONE_ATTR = "data-drop-zone";

/** The id of the innermost zone at `(x, y)` (CSS pixels in the page). */
export const zoneAt = (x: number, y: number, doc: Document = document): string | null => {
  const els = typeof doc.elementsFromPoint === "function" ? doc.elementsFromPoint(x, y) : [];
  for (const el of els) {
    const zone = el.closest<HTMLElement>(`[${ZONE_ATTR}]`);
    const id = zone?.getAttribute(ZONE_ATTR);
    if (id && zones.has(id)) return id;
  }
  return null;
};

/** A drop's position as the system gives it, in CSS pixels: macOS (in
 *  points) and Linux (GTK's logical pixels) give the page's own; Windows
 *  gives the device's pixels, scaled by the display. */
export const toCss = (p: { x: number; y: number }, platform: Platform, ratio: number): { x: number; y: number } =>
  platform === "windows" && ratio > 0 ? { x: p.x / ratio, y: p.y / ratio } : { x: p.x, y: p.y };

/** One of the system's drag and drop events, as Tauri gives them. */
export type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

/** Follows the system's drag and drop events for one window: which zone
 *  files are over, and the drop given to the zone under it. Something
 *  dragged that carries no files (an image or link dragged within the
 *  page, which on macOS comes this way too) is ignored. */
export class DropRouter {
  private carrying = false;

  constructor(
    private readonly at: (p: { x: number; y: number }) => string | null,
    private readonly over: (id: string | null) => void = (id) => useDropOver.setState({ over: id }),
  ) {}

  handle(e: DragDropPayload): void {
    switch (e.type) {
      case "enter":
        this.carrying = e.paths.length > 0;
        this.over(this.carrying ? this.at(e.position) : null);
        return;
      case "over":
        if (this.carrying) this.over(this.at(e.position));
        return;
      case "leave":
        this.carrying = false;
        this.over(null);
        return;
      case "drop": {
        this.carrying = false;
        this.over(null);
        if (!e.paths.length) return;
        const id = this.at(e.position);
        const zone = id ? zones.get(id) : undefined;
        zone?.drop(e.paths);
        return;
      }
    }
  }
}
