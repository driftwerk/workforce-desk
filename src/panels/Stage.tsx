import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useUi } from "../shell/ui";
import { DockStrip, DockTab } from "./DockTab";
import { clampWidth, fitWidths, HANDLE, maxWidth, MIN_WIDTH, spaceFor, STEP, wantedWidth, type PanelKind } from "./layout";

/** A column open on the right: what it is, what its tab says when it's
 *  docked, and what it shows (a `SidePanel`). */
export interface OpenPanel {
  kind: PanelKind;
  label: string;
  element: ReactNode;
}

/** The docked tabs' strip, beside a focused panel. */
const DOCK = 44;

interface Slot {
  kind: PanelKind;
  focused: boolean;
  docked: boolean;
}

const SlotContext = createContext<Slot | null>(null);
const MainHiddenContext = createContext(false);

/** Whether the main area is out of sight, behind a focused panel: what it
 *  holds stays mounted, but shouldn't answer keys. */
export const useMainHidden = (): boolean => useContext(MainHiddenContext);

/** Whether the column this is in is docked as a tab: still mounted, out
 *  of sight. */
export const useStowed = (): boolean => useContext(SlotContext)?.docked ?? false;

/** Whether what this is in is out of sight though mounted: its column
 *  docked as a tab, or the main area behind a focused column. Either is
 *  laid out still, so it reads as on screen to an IntersectionObserver. */
export const useOutOfSight = (): boolean => {
  const slot = useContext(SlotContext);
  const mainHidden = useContext(MainHiddenContext);
  return slot ? slot.docked : mainHidden;
};

/** A key pressed in a terminal is the terminal's: Esc there interrupts
 *  Claude Code, and doesn't leave a view. */
export const inTerminal = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest(".terminal-frame, .xterm");

/** The main area with the columns open on its right. Each column is
 *  dragged wider or narrower on its own (its width kept per kind), and
 *  focused to fill the main area: what the main area showed becomes a
 *  breadcrumb back, and the other columns fold into tabs. Nothing moves in
 *  the tree as it does — the main area and each column keep their place and
 *  are only shown or stowed — so a session's terminal carries on. */
export function Stage({ main, mainKey, mainName, panels }: { main: ReactNode; mainKey: string; mainName: string; panels: OpenPanel[] }) {
  const row = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const kept = useUi((s) => s.panelWidths);
  const stored = useUi((s) => s.panelFocus);
  /** A drag in progress: drawn at once, kept when it's let go. */
  const [live, setLive] = useState<{ kind: PanelKind; width: number } | null>(null);

  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => setRowWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const o = new ResizeObserver(measure);
    o.observe(el);
    return () => o.disconnect();
  }, []);

  const kinds = panels.map((p) => p.kind);
  // A focus on a panel that isn't open (yet: a session put back on launch
  // shows once the hub lists it) is no focus.
  const focus = stored && kinds.includes(stored.kind) ? stored : null;
  const beside = focus?.beside && kinds.includes(focus.beside) ? focus.beside : null;
  const columns = focus ? (beside ? [beside] : []) : kinds;
  const docked = focus ? panels.filter((p) => p.kind !== focus.kind) : [];
  const wanted = columns.map((k) => (live?.kind === k ? live.width : wantedWidth(k, kept)));
  const space = spaceFor(rowWidth - (docked.length ? DOCK : 0), columns.length);
  const shown = fitWidths(wanted, space);

  // A panel that closes is no longer focused or beside; the main area
  // showing something else (a room or view picked in the sidebar) brings
  // it back into sight. A change that came with its own focus (put back
  // from the hub) keeps that.
  const was = useRef<{ key: string; kinds: PanelKind[]; focus: typeof stored } | null>(null);
  const kindsKey = kinds.join(" ");
  useEffect(() => {
    const before = was.current;
    was.current = { key: mainKey, kinds: kindsKey ? (kindsKey.split(" ") as PanelKind[]) : [], focus: stored };
    if (!before || !stored) return;
    const ui = useUi.getState();
    for (const k of before.kinds) if (!kindsKey.split(" ").includes(k)) ui.panelClosed(k);
    if (before.key !== mainKey && before.focus === stored) ui.unfocusPanel();
  }, [mainKey, kindsKey, stored]);

  // Esc goes back, unless something nearer took it (a menu, a dialog, the
  // mention list) or it was typed into a terminal.
  const focused = !!focus;
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || inTerminal(e.target)) return;
      e.preventDefault();
      useUi.getState().unfocusPanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused]);

  const commit = (kind: PanelKind, width: number) => {
    setLive(null);
    useUi.getState().setPanelWidth(kind, width);
  };

  return (
    <MainHiddenContext.Provider value={focused}>
      <div className={`stage ${focused ? "stage-focused" : ""}`}>
        {focused && (
          <div className="stage-crumbs">
            <button type="button" className="crumb" aria-label={`Back to ${mainName}`} title="Back (Esc)" onClick={() => useUi.getState().unfocusPanel()}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M7.5 2.5L4 6l3.5 3.5" />
              </svg>
              {mainName}
            </button>
            <span className="faint small">Esc goes back</span>
          </div>
        )}
        <div ref={row} className={`stage-row ${columns.length || focused ? "stage-row-open" : ""}`}>
          <div key="main" className={`stage-main ${focused ? "stowed" : ""}`} aria-hidden={focused || undefined}>
            {main}
          </div>
          {panels.map((p) => {
            const i = columns.indexOf(p.kind);
            const place = focus?.kind === p.kind ? "focused" : i >= 0 ? "column" : "docked";
            const width = i >= 0 ? shown[i]! : wantedWidth(p.kind, kept);
            return (
              <div
                key={p.kind}
                className={`rpanel-slot rpanel-${place} ${place === "docked" ? "stowed" : ""}`}
                style={place === "focused" ? undefined : { width: place === "column" ? width + HANDLE : width }}
                data-panel={p.kind}
                aria-hidden={place === "docked" || undefined}
              >
                {place === "column" && (
                  <ResizeHandle
                    kind={p.kind}
                    label={p.label}
                    width={width}
                    max={maxWidth(shown, i, space)}
                    onLive={(w) => setLive({ kind: p.kind, width: w })}
                    onCommit={(w) => commit(p.kind, w)}
                  />
                )}
                <SlotContext.Provider value={{ kind: p.kind, focused: place === "focused", docked: place === "docked" }}>{p.element}</SlotContext.Provider>
              </div>
            );
          })}
          {docked.length > 0 && (
            <DockStrip key="dock" label="Other panels">
              {docked.map((p) => (
                <DockTab
                  key={p.kind}
                  label={p.label}
                  pressed={beside === p.kind}
                  title={beside === p.kind ? "Fold it back into a tab" : "Open it beside the focused view"}
                  onClick={() => useUi.getState().setBeside(beside === p.kind ? null : p.kind)}
                />
              ))}
            </DockStrip>
          )}
        </div>
      </div>
    </MainHiddenContext.Provider>
  );
}

/** A column's left edge: drag it, or focus it and use ← and →, to make the
 *  column wider or narrower; double-click puts its width back. */
function ResizeHandle({
  kind,
  label,
  width,
  max,
  onLive,
  onCommit,
}: {
  kind: PanelKind;
  label: string;
  width: number;
  max: number;
  onLive: (w: number) => void;
  onCommit: (w: number) => void;
}) {
  const drag = useRef<{ x: number; w: number; now: number } | null>(null);
  /** While it's dragged, however far the pointer strays from it. */
  const [dragging, setDragging] = useState(false);
  const stop = () => document.body.classList.remove("rpanel-resizing");
  useEffect(() => stop, []);
  const end = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    stop();
    // A click that didn't move it keeps the width it was given: what's
    // drawn may be that width shrunk to fit a narrow window.
    if (d && d.now !== d.w) onCommit(d.now);
  };
  const finite = Number.isFinite(max);
  return (
    <div
      className={`rpanel-handle ${dragging ? "rpanel-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={finite ? max : undefined}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width, now: width };
        setDragging(true);
        document.body.classList.add("rpanel-resizing");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // The handle is on the left: moving it left makes the column wider.
        d.now = clampWidth(d.w + (d.x - e.clientX), MIN_WIDTH, max);
        onLive(d.now);
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        end();
      }}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => useUi.getState().setPanelWidth(kind, null)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        onCommit(clampWidth(width + (e.key === "ArrowLeft" ? STEP : -STEP), MIN_WIDTH, max));
      }}
    >
      <span className="rpanel-grip" aria-hidden="true" />
    </div>
  );
}

const FocusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-5 5M2.5 13.5l5-5" />
  </svg>
);
const UnfocusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" />
  </svg>
);
export { FocusIcon, UnfocusIcon };

/** One right-hand column: its header (what it is, its own actions, focus
 *  and close) over what it shows. Every right-hand column is one of these,
 *  so they all resize, focus and dock alike. */
export function SidePanel({
  label,
  noun,
  title,
  actions,
  onClose,
  className = "",
  children,
}: {
  /** What the column is called, to assistive tech. */
  label: string;
  /** How its buttons name it: "the thread", "this session". */
  noun: string;
  title: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const slot = useContext(SlotContext);
  const ui = useUi.getState;
  return (
    <aside className={`rpanel ${className}`} aria-label={label}>
      <header className="rpanel-head">
        {title}
        <span className="rpanel-actions">
          {actions}
          {slot &&
            (slot.focused ? (
              <button type="button" className="icon-btn-sm rpanel-btn" aria-label="Back to a side panel" title="Back to a side panel (Esc)" onClick={() => ui().unfocusPanel()}>
                <UnfocusIcon />
              </button>
            ) : (
              <button type="button" className="icon-btn-sm rpanel-btn" aria-label={`Focus ${noun}`} title="Focus (fill the main space)" onClick={() => ui().focusPanel(slot.kind)}>
                <FocusIcon />
              </button>
            ))}
          <button
            type="button"
            className="icon-btn-sm rpanel-btn"
            aria-label={`Close ${noun}`}
            title="Close"
            onClick={() => {
              if (slot) ui().panelClosed(slot.kind);
              onClose();
            }}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </span>
      </header>
      {children}
    </aside>
  );
}
