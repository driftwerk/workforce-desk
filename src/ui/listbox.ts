import type { KeyboardEvent } from "react";

export interface ListboxActions {
  move: (index: number) => void;
  choose: (index: number) => void;
  close: () => void;
}

/** A key pressed in a list of `count` options whose `active` one is shown
 *  as current: ↑ ↓ move it, Enter chooses it, Escape closes the list; Home,
 *  End and Space do too, except from a field being typed in, whose text
 *  they belong to. Other keys are left alone. */
export function listboxKey(e: KeyboardEvent, count: number, active: number, act: ListboxActions, { typing = false } = {}): void {
  const last = count - 1;
  const move = (to: number) => {
    e.preventDefault();
    if (count > 0) act.move(Math.min(last, Math.max(0, to)));
  };
  switch (e.key) {
    case "ArrowDown":
      return move(active + 1);
    case "ArrowUp":
      return move(active - 1);
    case "Home":
      return typing ? undefined : move(0);
    case "End":
      return typing ? undefined : move(last);
    case " ":
      if (typing) return;
      e.preventDefault();
      if (active >= 0 && active < count) act.choose(active);
      return;
    case "Enter":
      e.preventDefault();
      if (active >= 0 && active < count) act.choose(active);
      return;
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      return act.close();
    default:
  }
}
