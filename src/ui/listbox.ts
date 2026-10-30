import type { KeyboardEvent } from "react";

export interface ListboxActions {
  move: (index: number) => void;
  choose: (index: number) => void;
  close: () => void;
}

/** A key pressed in a list of `count` options whose `active` one is shown
 *  as current: ↑ ↓ Home End move it, Enter (and Space, where it doesn't
 *  type) chooses it, Escape closes the list. Other keys are left alone. */
export function listboxKey(e: KeyboardEvent, count: number, active: number, act: ListboxActions, { space = true } = {}): void {
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
      return move(0);
    case "End":
      return move(last);
    case " ":
      if (!space) return;
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
