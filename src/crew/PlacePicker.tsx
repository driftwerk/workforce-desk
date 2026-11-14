import { useEffect, useMemo, useState } from "react";
import { useBoard } from "../board/store";
import { CloseButton, Dialog } from "../ui/Dialog";
import { kindOf, PLACE_KINDS, type Place } from "./places";

/** The most places a rule holds (`knows.rs`). */
export const MAX_PLACES = 64;

/** Picks the places an agent sees: groups, boards, grids, sessions and
 *  agents, any number of them, found by a filter. A place picked earlier
 *  that's gone stays picked until it is unticked. */
export function PlacePicker({
  who,
  places,
  initial,
  onUse,
  onClose,
}: {
  who: string;
  places: ReadonlyMap<string, Place>;
  initial: readonly string[];
  onUse: (places: string[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial.filter((p) => kindOf(p))));
  const [filter, setFilter] = useState("");
  const boardsKnown = useBoard((s) => Object.keys(s.boards).length > 0);
  useEffect(() => {
    if (!boardsKnown) void useBoard.getState().load();
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Picked before but not listed now: kept listed, so they can be unticked
  // and ticked again.
  const [gone] = useState<Place[]>(() =>
    initial.filter((p) => kindOf(p) && !places.has(p)).map((p) => ({ place: p, kind: kindOf(p)!, name: "One that’s gone", sub: "picked before" })),
  );
  const words = filter.trim().toLowerCase();
  const shown = useMemo(() => {
    const all = [...places.values(), ...gone];
    return PLACE_KINDS.map((k) => ({
      ...k,
      items: all.filter((p) => p.kind === k.kind && (!words || p.name.toLowerCase().includes(words) || (p.sub ?? "").toLowerCase().includes(words))),
    })).filter((k) => k.items.length > 0);
  }, [places, gone, words]);

  const toggle = (p: string) =>
    setPicked((was) => {
      const next = new Set(was);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const tooMany = picked.size > MAX_PLACES;

  return (
    <Dialog
      wide
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              What {who} sees
            </h1>
            <p className="small">Pick the places whose work {who} knows of. Their own work is always included.</p>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-scroll sees-pick">
        <input
          type="search"
          className="sees-pick-filter field-input"
          placeholder="Filter"
          aria-label="Filter places"
          data-autofocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {shown.length === 0 && <p className="small faint">{words ? "Nothing matches." : "Nothing to pick yet."}</p>}
        {shown.map((k) => (
          <fieldset key={k.kind} className="sees-pick-kind">
            <legend className="move-legend">{k.title}</legend>
            {k.items.map((p) => (
              <label key={p.place} className="sees-pick-row">
                <input type="checkbox" checked={picked.has(p.place)} onChange={() => toggle(p.place)} />
                <span className="sees-pick-name">{p.name}</span>
                {p.sub && <span className="sees-pick-sub">{p.sub}</span>}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <footer className="dialog-foot">
        <span className={`dialog-foot-note ${tooMany ? "state-blocked" : "faint"}`}>
          {tooMany ? `Pick at most ${MAX_PLACES}.` : picked.size === 0 ? "None picked" : `${picked.size} picked`}
        </span>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-signal" disabled={picked.size === 0 || tooMany} onClick={() => onUse([...picked])}>
          Use these
        </button>
      </footer>
    </Dialog>
  );
}
