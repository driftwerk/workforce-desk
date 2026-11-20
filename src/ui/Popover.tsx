import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const MARGIN = 8;

/** A small panel under the button that opened it (`from`), or under
 *  `anchor` when it's part of something wider, over everything and kept on
 *  screen, following it as it changes size: its right edge under the
 *  anchor's, or (`center`) centred under it. Escape or a click elsewhere
 *  closes it, and Escape puts focus back on that button; both are left to a
 *  menu opened from it. Its first control takes focus as it opens. */
export function Popover({
  label,
  from,
  anchor = from,
  onClose,
  children,
  className = "",
  align = "end",
}: {
  label: string;
  from: HTMLElement;
  anchor?: HTMLElement;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  align?: "end" | "center";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const at = anchor.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const wanted = align === "center" ? at.left + (at.width - box.width) / 2 : at.right - box.width;
    const left = Math.max(MARGIN, Math.min(wanted, window.innerWidth - box.width - MARGIN));
    const below = at.bottom + 6;
    const above = at.top - box.height - 6;
    const fitsBelow = below + box.height <= window.innerHeight - MARGIN;
    const top = fitsBelow ? below : above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - box.height - MARGIN);
    setPos((p) => (p?.left === left && p.top === top ? p : { left, top }));
  });
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button, [href], input")?.focus();
  }, [from]);
  useEffect(() => {
    const inMenu = (e: Event) => e.target instanceof Element && !!e.target.closest("[data-menu]");
    const away = (e: MouseEvent) => {
      if (inMenu(e) || (e.target instanceof Node && (ref.current?.contains(e.target) || from.contains(e.target)))) return;
      close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || inMenu(e)) return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
      from.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
    };
  }, [from]);
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
