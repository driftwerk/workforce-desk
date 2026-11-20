import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export type MenuEntry =
  /** `checked`: a setting it turns on or off, shown ticked while on. */
  /** `disabled`: said and reachable, but choosing it does nothing. */
  /** `hint`: a quiet word after the label ("Morning · the empty pane"). */
  /** `radio`: one of a set of choices (`checked` the one in force).
   *  `detail`: a quiet line under the label, saying what it does. */
  | {
      kind: "item";
      label: string;
      hint?: string;
      detail?: string;
      kbd?: string;
      checked?: boolean;
      radio?: boolean;
      disabled?: boolean;
      onSelect?: () => void;
      submenu?: Submenu;
    }
  | { kind: "separator" }
  /** A quiet line at the menu's foot, never focused: what its choices
   *  are kept for. The menu is described by it. */
  | { kind: "note"; text: string };

/** A submenu's entries, or how to make them as it opens: for one that
 *  follows what changes often (a list of sessions), so what offers it isn't
 *  drawn again for each change. */
export type Submenu = MenuEntry[] | (() => MenuEntry[]);

/** A submenu's entries, made now when it makes them as it opens. */
export const entriesOf = (submenu: Submenu): MenuEntry[] => (typeof submenu === "function" ? submenu() : submenu);

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
  const noteId = useId();
  const noted = entries.some((e) => e.kind === "note");
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
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, []);

  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(':scope > [role^="menuitem"]') ?? [])];

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
      aria-describedby={noted ? noteId : undefined}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) =>
        entry.kind === "separator" ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : entry.kind === "note" ? (
          <p key={i} id={noteId} className="menu-note" role="none">
            {entry.text}
          </p>
        ) : (
          <button
            key={i}
            type="button"
            role={entry.radio ? "menuitemradio" : entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={entry.radio ? !!entry.checked : entry.checked}
            aria-disabled={entry.disabled || undefined}
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
            onClick={(e) => (entry.disabled ? undefined : entry.submenu ? openSub(i, e.currentTarget, true) : onChoose(entry.onSelect))}
          >
            <ItemBody entry={entry} />
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
              entries={entriesOf(entry.submenu)}
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

type Item = Extract<MenuEntry, { kind: "item" }>;

/** What an item shows: its label, hint and detail, its keys, a tick when
 *  it's on, and an arrow when it opens a submenu. */
function ItemBody({ entry }: { entry: Item }) {
  return (
    <>
      <span className="menu-label">
        {entry.label}
        {entry.hint && <span className="menu-hint"> · {entry.hint}</span>}
        {entry.detail && <span className="menu-detail">{entry.detail}</span>}
      </span>
      {entry.kbd && <span className="menu-kbd">{entry.kbd}</span>}
      {entry.checked && (
        <span className="menu-kbd" aria-hidden="true">
          ✓
        </span>
      )}
      {entry.submenu && (
        <span className="menu-kbd" aria-hidden="true">
          ▸
        </span>
      )}
    </>
  );
}

/** Entries as runs: a set of radio choices together, anything else alone. */
const runs = (entries: MenuEntry[]): { at: number; entries: MenuEntry[] }[] =>
  entries.reduce<{ at: number; entries: MenuEntry[] }[]>((all, entry, at) => {
    const last = all.at(-1);
    const radio = (e: MenuEntry | undefined) => e?.kind === "item" && !!e.radio;
    return radio(entry) && radio(last?.entries[0]) ? [...all.slice(0, -1), { at: last!.at, entries: [...last!.entries, entry] }] : [...all, { at, entries: [entry] }];
  }, []);

/** A menu's entries as rows in place, in a popover: a choice runs at once,
 *  a submenu opens as a menu under its row. */
export function MenuRows({ label, entries }: { label: string; entries: MenuEntry[] }) {
  const [open, setOpen] = useState<{ index: number; at: { x: number; y: number }; from: HTMLElement } | null>(null);
  const sub = open ? entries[open.index] : undefined;
  const row = (entry: MenuEntry, i: number) =>
    entry.kind === "separator" ? (
      <div key={i} className="menu-sep" role="separator" />
    ) : entry.kind === "note" ? (
      <p key={i} className="menu-note">
        {entry.text}
      </p>
    ) : (
      <button
        key={i}
        type="button"
        className="menu-item menu-row"
        role={entry.radio ? "radio" : undefined}
        aria-checked={entry.radio ? !!entry.checked : undefined}
        aria-pressed={entry.radio || entry.submenu ? undefined : entry.checked}
        aria-disabled={entry.disabled || undefined}
        aria-haspopup={entry.submenu ? "menu" : undefined}
        aria-expanded={entry.submenu ? open?.index === i : undefined}
        onClick={(e) => {
          if (entry.disabled) return;
          if (!entry.submenu) return entry.onSelect?.();
          const r = e.currentTarget.getBoundingClientRect();
          setOpen({ index: i, at: { x: r.left, y: r.bottom + 4 }, from: e.currentTarget });
        }}
      >
        <ItemBody entry={entry} />
      </button>
    );
  return (
    <div className="menu-rows" role="group" aria-label={label}>
      {runs(entries).map((run) =>
        run.entries.length > 1 ? (
          <div key={run.at} role="radiogroup" className="menu-radios">
            {run.entries.map((e, i) => row(e, run.at + i))}
          </div>
        ) : (
          row(run.entries[0]!, run.at)
        ),
      )}
      {open && sub?.kind === "item" && sub.submenu && (
        <Menu
          label={sub.label}
          at={open.at}
          entries={entriesOf(sub.submenu)}
          onClose={(refocus) => {
            setOpen(null);
            if (refocus) open.from.focus();
          }}
        />
      )}
    </div>
  );
}
