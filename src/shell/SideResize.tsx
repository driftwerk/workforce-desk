import { useEffect, useRef } from "react";
import { SIDE_BIG_STEP, SIDE_MAX, SIDE_MIN, SIDE_STEP, useSideWidth } from "./sideWidth";

/** The sidebar's right edge as a separator: drag it (or use the arrow keys,
 *  Home and End) to set the width; double-click or Enter resets it. */
export function SideResize() {
  const width = useSideWidth((s) => s.width);
  const drag = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => () => document.body.classList.remove("side-resizing"), []);
  const { setWidth, reset } = useSideWidth.getState();
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    document.body.classList.remove("side-resizing");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return (
    <div
      className="side-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuenow={width}
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      title="Drag to resize; double-click to reset"
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
        document.body.classList.add("side-resizing");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d && e.currentTarget.hasPointerCapture(e.pointerId)) setWidth(d.w + (e.clientX - d.x));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={() => {
        drag.current = null;
        document.body.classList.remove("side-resizing");
      }}
      onDoubleClick={reset}
      onKeyDown={(e) => {
        const by = e.shiftKey ? SIDE_BIG_STEP : SIDE_STEP;
        if (e.key === "ArrowLeft") setWidth(width - by);
        else if (e.key === "ArrowRight") setWidth(width + by);
        else if (e.key === "Home") setWidth(SIDE_MIN);
        else if (e.key === "End") setWidth(SIDE_MAX);
        else if (e.key === "Enter") reset();
        else return;
        e.preventDefault();
      }}
    />
  );
}
