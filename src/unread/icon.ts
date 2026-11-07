import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { inApp } from "../platform";
import { useTheme } from "../theme/store";
import { countLabel, type Badge } from "./badges";
import { useTotal } from "./Marks";

// The app's icon and window title say what's unread, from the main window
// only: macOS shows the count (or a dot) on the dock icon, Linux the count on
// its launcher entry, Windows an overlay drawn here. It's drawn on every
// system and used only on Windows, so this side needs no check of which
// it's on; the title is the app's to write.

/** The overlay's side, in pixels. */
export const OVERLAY_PX = 32;

/** Windows' taskbar overlay: the count, "99+" or a dot, on a `fill` disc
 *  with the count in `ink`, as 32×32 RGBA; none when nothing is unread or the
 *  canvas can't draw. */
export const overlayFor = (
  b: Badge,
  fill: string,
  ink: string,
  canvas: HTMLCanvasElement = document.createElement("canvas"),
): number[] | null => {
  if (!b.count && !b.dot) return null;
  canvas.width = OVERLAY_PX;
  canvas.height = OVERLAY_PX;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const mid = OVERLAY_PX / 2;
  g.clearRect(0, 0, OVERLAY_PX, OVERLAY_PX);
  g.fillStyle = fill;
  g.beginPath();
  g.arc(mid, mid, b.count ? mid : mid / 2, 0, Math.PI * 2);
  g.fill();
  if (b.count) {
    const label = countLabel(b.count);
    g.fillStyle = ink;
    g.font = `700 ${label.length > 2 ? 13 : label.length > 1 ? 17 : 21}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, mid, mid + 1);
  }
  return Array.from(g.getImageData(0, 0, OVERLAY_PX, OVERLAY_PX).data);
};

/** Keeps the app's icon and title on what's unread, in the theme's signal
 *  with its text on it, and redrawn when the theme changes. */
export function useAppBadge(): void {
  const total = useTotal();
  const { count, dot } = total;
  const { signal, onSignal } = useTheme().colors;
  useEffect(() => {
    if (!inApp) return;
    void invoke("set_unread_badge", { count, dot, overlay: overlayFor({ count, dot }, signal, onSignal) }).catch((e: unknown) =>
      console.warn("unread badge:", e),
    );
  }, [count, dot, signal, onSignal]);
}
