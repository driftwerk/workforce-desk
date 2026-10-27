import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent } from "react";
import { inApp } from "../platform";

/** Moves the window from a custom title area. Unlike Tauri's
 *  `data-tauri-drag-region`, a double-click doesn't toggle maximise, which a
 *  focus click followed by a drag could trigger mid-move. */
export const dragWindow = (e: MouseEvent): void => {
  if (!inApp || e.button !== 0 || e.detail > 1) return;
  e.preventDefault();
  void getCurrentWindow().startDragging();
};
