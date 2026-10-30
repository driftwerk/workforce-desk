import { useEffect, useId, useRef, useState } from "react";
import { listboxKey } from "../ui/listbox";

/** The fonts Desk carries itself, offered first. */
export const DESK_FONTS = ["Bricolage Grotesque Variable", "Figtree Variable", "Geist Mono Variable"] as const;

export interface FontOption {
  name: string;
  /** One of Desk's own, rather than this computer's. */
  desk: boolean;
}

/** Desk's fonts, then the computer's (each once). */
export const fontOptions = (system: readonly string[]): FontOption[] => [
  ...DESK_FONTS.map((name) => ({ name, desk: true })),
  ...system.filter((name) => !(DESK_FONTS as readonly string[]).includes(name)).map((name) => ({ name, desk: false })),
];

/** The options whose name holds `query`, case aside. */
export const matching = (options: readonly FontOption[], query: string): FontOption[] => {
  const q = query.trim().toLowerCase();
  return q ? options.filter((o) => o.name.toLowerCase().includes(q)) : [...options];
};

/** A CSS font stack that draws `name`, or the system's face without it. */
export const faceOf = (name: string): string => `"${name.replace(/["\\]/g, "")}", system-ui`;

/** The most options drawn at once (each loads its own face); typing finds the rest. */
const SHOWN = 80;

/** The first of `found` to draw, with `value` among them wherever it is. */
export const firstShown = (found: readonly FontOption[], value: string): FontOption[] => {
  const shown = found.slice(0, SHOWN);
  const current = found.find((o) => o.name === value);
  return current && !shown.includes(current) ? [...shown, current] : shown;
};

/** A font for one role: a button showing it in its own face, opening a
 *  searchable list of Desk's fonts and this computer's, each in its face. */
export function FontPicker({
  label,
  hint,
  value,
  options,
  onPick,
}: {
  label: string;
  hint: string;
  value: string;
  options: readonly FontOption[];
  onPick: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const found = matching(options, query);
  const shown = firstShown(found, value);

  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) button.current?.focus();
  };
  const show = () => {
    setActive(Math.max(0, firstShown(options, value).findIndex((o) => o.name === value)));
    setOpen(true);
  };
  const pick = (name: string) => {
    onPick(name);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !button.current?.contains(t)) close(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const counted = query.trim()
    ? `${found.length} of ${options.length} fonts matching “${query.trim()}”`
    : `${options.length} fonts · Desk’s first, then this computer’s`;

  return (
    <div className="font-picker">
      <span className="field-label" id={`${id}-label`}>
        {label} <span className="faint">· {hint}</span>
      </span>
      <button
        ref={button}
        type="button"
        className="font-face-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            show();
          }
        }}
      >
        <span className="font-sample" style={{ fontFamily: faceOf(value) }} aria-hidden="true">
          Aa
        </span>
        <span id={`${id}-value`} className="font-name">
          {value}
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M2 4l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div
          ref={pop}
          className="font-pop"
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            if (!e.currentTarget.contains(to) && to !== button.current) close(false);
          }}
        >
          <input
            autoFocus
            className="font-search"
            role="combobox"
            aria-label={`Search fonts for ${label.toLowerCase()}`}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={shown[active] ? `${id}-${active}` : undefined}
            placeholder="Search fonts"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) =>
              listboxKey(e, shown.length, active, { move: setActive, choose: (i) => pick(shown[i]!.name), close: () => close() }, { typing: true })
            }
          />
          <span className="small faint font-count" aria-live="polite">
            {counted}
          </span>
          <ul ref={list} id={`${id}-list`} className="font-list" role="listbox" aria-label={`${label} font`}>
            {shown.map((o, i) => (
              <li
                key={o.name}
                id={`${id}-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.name === value}
                className={`font-opt ${i === active ? "active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o.name)}
              >
                <span className="font-sample" style={{ fontFamily: faceOf(o.name) }} aria-hidden="true">
                  Aa
                </span>
                <span className="font-name" style={{ fontFamily: faceOf(o.name) }}>
                  {o.name}
                </span>
                <span className="font-tag">{o.desk ? "Desk" : "This computer"}</span>
              </li>
            ))}
          </ul>
          {found.length === 0 && <span className="font-none small faint">No font is called that.</span>}
          {found.length > shown.length && <span className="small faint font-count">Type to find the other {found.length - shown.length}.</span>}
        </div>
      )}
    </div>
  );
}
