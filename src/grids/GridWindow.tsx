import { getCurrentWindow } from "@tauri-apps/api/window";
import { LifecycleDialogs } from "../session/LifecycleDialogs";
import { useEffect, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import {
  closeGridWindow,
  gridWindowMonitor,
  hubAccounts,
  inApp,
  listen,
  localHub,
  monitorsNow,
  onThemesChanged,
  setGridWindowMode,
  subscribe,
} from "../platform";
import { deskState } from "../restore/boot";
import { useSettings } from "../settings/store";
import { reloadDesk } from "../shortcuts/reload";
import { useAppShortcut } from "../shortcuts/manager";
import { applyTheme, useTheme, useThemeStore } from "../theme/store";
import { dragWindow } from "../ui/drag";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { Menu, type MenuEntry } from "../ui/Menu";
import { PRESETS } from "./engine";
import { countsLine, GridCanvas, GridName, LayoutUndo, useFillKeys, useGridCounts } from "./GridView";
import { WINDOW_MODES, type WindowMode } from "./model";
import { layOut, newTerminal, setPlacement, useGrids } from "./store";
import { startGridsHere } from "./windows";
import { loadCustomThemes } from "../theme/custom";
import { startUnread } from "../unread/summary";

/** How long a moved window waits to be still before its monitor is read. */
const SETTLE_MS = 700;

/** A grid in a window of its own: the grid alone, under a slim header. It
 *  has its own connection to the hub and none of the main window's work —
 *  no global shortcuts, voice, Tuple or notifications. */
export function GridWindow({ gridId }: { gridId: string }) {
  const grid = useGrids((s) => s.grids[gridId]);
  const ready = useGrids((s) => s.ready);
  const theme = useTheme();
  const counts = useGridCounts(grid);
  const [layoutMenu, setLayoutMenu] = useState<{ x: number; y: number; from: HTMLElement } | null>(null);
  const placement = useRef(grid?.placement);
  placement.current = grid?.placement;

  useEffect(() => applyTheme(theme), [theme]);
  // What its panes show is read here too: sessions by what the summary says
  // they did since, with the points every window writes.
  useEffect(() => startUnread(), []);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => useThemeStore.getState().setSystemDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let stopGrids: (() => void) | undefined;
    let gone = false;
    const { fail } = useDesk.getState();
    // Settings are only read here: the main window is the one that saves them.
    void useSettings.getState().load().catch(fail);
    const refresh = () => loadCustomThemes().then(useThemeStore.getState().setCustom).catch(fail);
    refresh();
    const unlisten = subscribe(onThemesChanged(refresh));
    localHub()
      .then((t) => (stop = useDesk.getState().connect(t, { notify: false })))
      .then(() => hubAccounts())
      .then(useChat.getState().setHubs)
      .catch(fail);
    void startGridsHere({ kind: "grid", gridId }).then((s) => (gone ? s() : (stopGrids = s)));
    return () => {
      gone = true;
      stop?.();
      stopGrids?.();
      unlisten();
    };
  }, [gridId]);

  // Back to the main window: from the button, or the window's close button.
  const moveBack = async () => {
    const p = placement.current;
    if (p) setPlacement(gridId, { kind: "main" });
    await deskState.flush().catch(() => undefined);
    await closeGridWindow(gridId).catch(() => undefined);
  };
  const moveBackRef = useRef(moveBack);
  moveBackRef.current = moveBack;
  useEffect(() => (inApp ? subscribe(listen("grid-close", () => void moveBackRef.current())) : undefined), []);

  // Dragged to another monitor: the grid is that monitor's now (unless its
  // own went away, which moves it too), and a filling window fills it.
  useEffect(() => {
    if (!inApp) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = async () => {
      const p = placement.current;
      if (p?.kind !== "window") return;
      const [here, all] = await Promise.all([gridWindowMonitor(), monitorsNow()]);
      if (!here || (p.monitor && here.id === p.monitor.id && here.origin.join() === p.monitor.origin.join())) return;
      if (p.monitor && !all.some((m) => m.id === p.monitor!.id)) return;
      setPlacement(gridId, { ...p, monitor: { id: here.id, name: here.name, origin: here.origin } });
      if (p.mode === "fill") void setGridWindowMode("fill");
    };
    const moved = getCurrentWindow().onMoved(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void settled(), SETTLE_MS);
    });
    return () => {
      clearTimeout(timer);
      void moved.then((u) => u());
    };
  }, [gridId]);

  useAppShortcut("newTerminal", () => newTerminal(gridId), !!grid);
  useAppShortcut("reload", reloadDesk);
  useFillKeys(gridId, !!grid);

  if (!ready) return <div className="grid-window" />;
  if (!grid) {
    return (
      <div className="grid-window grids-none">
        <p className="muted">This grid was deleted.</p>
      </div>
    );
  }
  const p = grid.placement;
  const mode: WindowMode = p.kind === "window" ? p.mode : "fill";
  const chooseMode = (m: WindowMode) => {
    if (p.kind !== "window" || m === p.mode) return;
    setPlacement(gridId, { ...p, mode: m });
    void setGridWindowMode(m).catch(useDesk.getState().fail);
  };
  const layoutEntries: MenuEntry[] = [
    ...PRESETS.map((x): MenuEntry => ({ kind: "item", label: x.name, onSelect: () => layOut(gridId, x.id) })),
    { kind: "separator" },
    { kind: "item", label: "New terminal", onSelect: () => newTerminal(gridId) },
  ];
  const where = p.kind === "window" ? p.monitor?.name : null;
  return (
    <div className="grid-window">
      <header className="gwin-head" onMouseDown={(e) => e.target === e.currentTarget && dragWindow(e)}>
        <GridName grid={grid} className="gwin-title display" />
        <span className="faint small" onMouseDown={dragWindow}>
          {[where, countsLine(counts)].filter(Boolean).join(" · ")}
        </span>
        <span className="grids-fill" onMouseDown={dragWindow} />
        <LayoutUndo gridId={grid.id} />
        <label className="gwin-mode small">
          Window
          <select value={mode} onChange={(e) => chooseMode(e.target.value as WindowMode)}>
            {WINDOW_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-ghost gbtn"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setLayoutMenu({ x: r.left, y: r.bottom + 4, from: e.currentTarget });
          }}
        >
          Layout ▾
        </button>
        <button type="button" className="btn btn-ghost gbtn" onClick={() => void moveBack()}>
          Move back to the main window
        </button>
      </header>
      <ErrorBoundary name="grid">
        <GridCanvas grid={grid} />
      </ErrorBoundary>
      <LifecycleDialogs />
      {layoutMenu && (
        <Menu
          label="Layout"
          at={layoutMenu}
          entries={layoutEntries}
          onClose={(refocus) => {
            if (refocus) layoutMenu.from.focus();
            setLayoutMenu(null);
          }}
        />
      )}
      <Toast />
    </div>
  );
}

function Toast() {
  const { error, clearError } = useDesk();
  if (!error) return null;
  return (
    <div className="toast" role="alert">
      <span>{error}</span>
      <button type="button" className="link" onClick={clearError}>
        Dismiss
      </button>
    </div>
  );
}
