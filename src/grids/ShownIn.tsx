import { shownGrid, useGrids } from "./store";
import type { Place } from "./where";
import { addToGrid, goTo } from "./windows";

/** Where a session or agent already is (see `placesOf`), each with a way
 *  there: its own pane in a grid, the terminal in a grid a session runs in,
 *  or a Desk terminal no grid shows (`loose`), which is put in the grid
 *  shown now. `onShown` closes the side panel once it's in sight. */
export function ShownIn({ places, loose, onShown }: { places: Place[]; loose: string | null; onShown: () => void }) {
  const grids = useGrids((s) => s.grids);
  const go = (p: Place) => goTo(p) && onShown();
  const line = (p: Place, says: string, label: string) => {
    const grid = grids[p.gridId]?.name ?? "a grid";
    return (
      <li key={p.paneId}>
        <span>
          {says} <span className="strong">{grid}</span>
        </span>
        <button type="button" className="link small" aria-label={`${label} in ${grid}`} onClick={() => go(p)}>
          {label}
        </button>
      </li>
    );
  };
  return (
    <ul className="session-where small" aria-label="Where it is">
      {places.filter((p) => p.content.kind !== "terminal").map((p) => line(p, "In grid", "Go to it"))}
      {places.filter((p) => p.content.kind === "terminal").map((p) => line(p, "Running in a terminal in", "Go to the terminal"))}
      {loose && (
        <li>
          <span>Running in a Desk terminal that isn’t in a grid</span>
          <button
            type="button"
            className="link small"
            onClick={() => addToGrid({ kind: "terminal", terminalId: loose }, shownGrid(useGrids.getState())?.id ?? null).shown && onShown()}
          >
            Show it
          </button>
        </li>
      )}
    </ul>
  );
}
