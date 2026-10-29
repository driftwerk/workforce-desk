import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export type MenuEntry =
  | { kind: "item"; label: string; kbd?: string; onSelect?: () => void; submenu?: MenuEntry[] }
  | { kind: "separator" };

const MARGIN = 8;

/** A context menu over everything, at a point (kept on screen): arrows move,
 *  → opens a submenu and ← or Escape closes it, Enter chooses, Escape or a
 *  click elsewhere closes. Choosing closes every level and puts focus back
 *  where the menu was opened from, before the choice runs. */
export function Menu({
  label,
  at,
  entries,
  onClose,
}: {
  label: string;
  at: { x: number; y: number };
  entries: MenuEntry[];
  /** `refocus` is false when the menu closed because of a click elsewhere. */
  onClose: (refocus: boolean) => void;
}) {
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!(e.target instanceof Element && e.target.closest("[data-menu]"))) onClose(false);
    };
    const blur = () => onClose(false);
    document.addEventListener("mousedown", away);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("blur", blur);
    };
  }, [onClose]);
  return createPortal(
    <MenuList
      label={label}
      at={at}
      entries={entries}
      onBack={() => onClose(true)}
      onChoose={(f) => {
        onClose(true);
        f?.();
      }}
      onTab={() => onClose(true)}
    />,
    document.body,
  );
}

function MenuList({
  label,
  at,
  entries,
  onBack,
  onChoose,
  onTab,
  beside,
}: {
  label: string;
  at: { x: number; y: number };
  entries: MenuEntry[];
  /** Escape (and ← in a submenu). */
  onBack: () => void;
  onChoose: (f?: () => void) => void;
  onTab: () => void;
  /** A submenu's parent item: it opens to its right, or left when there's
   *  no room. */
  beside?: DOMRect;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect; focus: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxX = window.innerWidth - width - MARGIN;
    const maxY = window.innerHeight - height - MARGIN;
    const x = beside && beside.right + width + MARGIN > window.innerWidth ? beside.left - width : at.x;
    setPos({ x: Math.max(MARGIN, Math.min(x, maxX)), y: Math.max(MARGIN, Math.min(at.y, maxY)) });
  }, [at, beside]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);

  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]') ?? [])];

  const openSub = (index: number, el: HTMLElement, focus: boolean) => setSub({ index, rect: el.getBoundingClientRect(), focus });

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof Element && e.target.closest("[data-menu]") !== ref.current) return;
    const all = items();
    const now = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      all[(i + all.length) % all.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return go(now + 1);
      case "ArrowUp":
        return go(now < 0 ? all.length - 1 : now - 1);
      case "Home":
        return go(0);
      case "End":
        return go(all.length - 1);
      case "ArrowRight": {
        const el = all[now];
        const index = Number(el?.dataset.index);
        const entry = entries[index];
        if (el && entry?.kind === "item" && entry.submenu) {
          e.preventDefault();
          openSub(index, el, true);
        }
        return;
      }
      case "ArrowLeft":
        if (!beside) return;
        e.preventDefault();
        e.stopPropagation();
        return onBack();
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        return onBack();
      case "Tab":
        e.preventDefault();
        return onTab();
      default:
    }
  };

  return (
    <div
      ref={ref}
      data-menu
      className="menu"
      role="menu"
      aria-label={label}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) =>
        entry.kind === "separator" ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className="menu-item"
            data-index={i}
            tabIndex={-1}
            aria-haspopup={entry.submenu ? "menu" : undefined}
            aria-expanded={entry.submenu ? sub?.index === i : undefined}
            onMouseEnter={(e) => {
              e.currentTarget.focus();
              if (entry.submenu) openSub(i, e.currentTarget, false);
              else setSub(null);
            }}
            onClick={(e) => (entry.submenu ? openSub(i, e.currentTarget, true) : onChoose(entry.onSelect))}
          >
            <span className="menu-label">{entry.label}</span>
            {entry.kbd && <span className="menu-kbd">{entry.kbd}</span>}
            {entry.submenu && (
              <span className="menu-kbd" aria-hidden="true">
                ▸
              </span>
            )}
          </button>
        ),
      )}
      {sub &&
        (() => {
          const entry = entries[sub.index];
          if (entry?.kind !== "item" || !entry.submenu) return null;
          return (
            <SubMenu
              key={sub.index}
              label={entry.label}
              rect={sub.rect}
              entries={entry.submenu}
              focus={sub.focus}
              onBack={() => {
                setSub(null);
                ref.current?.querySelector<HTMLElement>(`[data-index="${sub.index}"]`)?.focus();
              }}
              onChoose={onChoose}
              onTab={onTab}
            />
          );
        })()}
    </div>
  );
}

function SubMenu({
  label,
  rect,
  entries,
  focus,
  onBack,
  onChoose,
  onTab,
}: {
  label: string;
  rect: DOMRect;
  entries: MenuEntry[];
  focus: boolean;
  onBack: () => void;
  onChoose: (f?: () => void) => void;
  onTab: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  // The list focuses its first item when it opens; opened by hovering, focus
  // stays on the parent item.
  const parent = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    if (!focus) parent.current?.focus();
  }, [focus]);
  return (
    <div ref={wrap} className="menu-sub">
      <MenuList
        label={label}
        at={{ x: rect.right + 2, y: rect.top - 7 }}
        beside={rect}
        entries={entries}
        onBack={onBack}
        onChoose={onChoose}
        onTab={onTab}
      />
    </div>
  );
}
