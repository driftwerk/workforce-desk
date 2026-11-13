import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const MARGIN = 8;

/** A small panel under the button that opened it (`from`), over everything
 *  and kept on screen: Escape or a click elsewhere closes it, and Escape
 *  puts focus back on that button. Its first control takes focus. */
export function Popover({ label, from, onClose, children, className = "" }: { label: string; from: HTMLElement; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const at = from.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    // Its right edge under the button's, unless that runs off the left.
    const left = Math.max(MARGIN, Math.min(at.right - box.width, window.innerWidth - box.width - MARGIN));
    const below = at.bottom + 6;
    const top = below + box.height > window.innerHeight - MARGIN ? Math.max(MARGIN, at.top - box.height - 6) : below;
    setPos({ left, top });
  }, [from]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button, [href], input")?.focus();
    const away = (e: MouseEvent) => {
      if (e.target instanceof Node && (ref.current?.contains(e.target) || from.contains(e.target))) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
      from.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
    };
  }, [from, onClose]);
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`popover ${className}`}
      // It's drawn over everything, but React passes its events up to what
      // opened it: a press in it never drags a pane, a right click never
      // opens the menu behind it.
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
