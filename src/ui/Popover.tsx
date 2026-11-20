import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const MARGIN = 8;

/** A small panel under the button that opened it (`from`), over everything
 *  and kept on screen: its right edge under the button's, or (`center`)
 *  centred under it. Escape or a click elsewhere closes it, and Escape puts
 *  focus back on that button; both are left to a menu opened from it. Its
 *  first control takes focus. */
export function Popover({
  label,
  from,
  onClose,
  children,
  className = "",
  align = "end",
}: {
  label: string;
  from: HTMLElement;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  align?: "end" | "center";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const at = from.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const wanted = align === "center" ? at.left + (at.width - box.width) / 2 : at.right - box.width;
    const left = Math.max(MARGIN, Math.min(wanted, window.innerWidth - box.width - MARGIN));
    const below = at.bottom + 6;
    const above = at.top - box.height - 6;
    // Above only when it doesn't fit below and does there: never over the button.
    const top = below + box.height > window.innerHeight - MARGIN && above >= MARGIN ? above : below;
    setPos({ left, top });
  }, [from, align]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button, [href], input")?.focus();
    const inMenu = (e: Event) => e.target instanceof Element && !!e.target.closest("[data-menu]");
    const away = (e: MouseEvent) => {
      if (inMenu(e) || (e.target instanceof Node && (ref.current?.contains(e.target) || from.contains(e.target)))) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || inMenu(e)) return;
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
