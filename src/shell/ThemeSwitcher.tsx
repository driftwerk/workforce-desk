import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { isBuiltin } from "../settings/editing";
import { chooserThemes, isMode, pickedTheme, useThemeStore, type Mode } from "../theme/store";
import { derive, type ThemeSpec } from "../theme/tokens";
import { radioKeys } from "../ui/Dialog";

const MODE_NAMES: readonly [Mode, string][] = [
  ["system", "Auto"],
  ["night", "Night"],
  ["day", "Day"],
];

/** Where a theme came from, as Settings → Appearance says it. */
export const themeSource = (t: ThemeSpec): string => (isBuiltin(t.id) ? "Built in" : "Yours");

function Swatch({ spec }: { spec: ThemeSpec }) {
  const c = derive(spec).colors;
  return (
    <span className="look-swatch" style={{ background: c.bg }} aria-hidden="true">
      <span style={{ background: c.signal }} />
    </span>
  );
}

/** The sidebar's look: Auto · Night · Day, and beside them a chooser for
 *  every other theme (Harbour until another is picked). Picking from the
 *  chooser turns the three off; clicking one of them puts it back. */
export function ThemeSwitcher({ onSettings }: { onSettings: () => void }) {
  const { choice, pick, custom, setChoice } = useThemeStore();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const themes = chooserThemes(custom);
  const current = pickedTheme(pick, custom);
  const chosen = !isMode(choice);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const listId = useId();
  const checked = MODE_NAMES.findIndex(([id]) => id === choice);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const show = () => {
    const at = themes.findIndex((t) => t.id === current.id);
    setActive(Math.max(0, at));
    setOpen(true);
  };

  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const choose = (t: ThemeSpec) => {
    setChoice(t.id);
    close();
  };

  const onListKey = (e: KeyboardEvent) => {
    const last = themes.length - 1;
    const move = (to: number) => {
      e.preventDefault();
      setActive(Math.min(last, Math.max(0, to)));
    };
    switch (e.key) {
      case "ArrowDown":
        return move(active + 1);
      case "ArrowUp":
        return move(active - 1);
      case "Home":
        return move(0);
      case "End":
        return move(last);
      case "Enter":
      case " ": {
        e.preventDefault();
        const t = themes[active];
        if (t) choose(t);
        return;
      }
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        return close();
      default:
    }
  };

  return (
    <div className="look">
      <div className="look-modes" role="radiogroup" aria-label="Look">
        {MODE_NAMES.map(([id, name], i) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={choice === id}
            tabIndex={i === (checked < 0 ? 0 : checked) ? 0 : -1}
            title={id === "system" ? "Night or Day, with macOS" : undefined}
            onClick={() => setChoice(id)}
            onKeyDown={(e) => radioKeys(e, MODE_NAMES, checked, ([next]) => setChoice(next))}
          >
            {name}
          </button>
        ))}
      </div>
      <button
        ref={button}
        type="button"
        className={`look-chooser ${chosen ? "on" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Theme: ${current.name}${chosen ? ", in use" : ""}`}
        title={current.name}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            show();
          }
        }}
      >
        <Swatch spec={current} />
        <span className="look-chooser-name">{current.name}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M2 4l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div
          ref={pop}
          className="look-pop"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            close();
          }}
        >
          <span className="look-pop-label faint small" id={`${listId}-label`}>
            Themes
          </span>
          <ul
            ref={list}
            id={listId}
            className="look-list"
            role="listbox"
            aria-labelledby={`${listId}-label`}
            tabIndex={0}
            aria-activedescendant={themes[active] ? `${listId}-${active}` : undefined}
            onKeyDown={onListKey}
          >
            {themes.map((t, i) => {
              const on = chosen && t.id === choice;
              return (
                <li
                  key={t.id}
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={on}
                  className={`look-opt ${i === active ? "active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(t)}
                >
                  <Swatch spec={t} />
                  <span className="look-opt-name">{t.name}</span>
                  <span className="faint small">{themeSource(t)}</span>
                  <span className="look-check" aria-hidden="true">
                    {on ? "✓" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          <span className="look-rule" aria-hidden="true" />
          <button
            type="button"
            className="look-opt look-settings"
            onClick={() => {
              close(false);
              onSettings();
            }}
          >
            Import or edit themes in Settings…
          </button>
        </div>
      )}
    </div>
  );
}
