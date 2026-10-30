import { useEffect, type RefObject } from "react";
import { create } from "zustand";

/** Where the person asked to type next: `agent:<hub>/<agent>` for a DM,
 *  `room:<room>` or `room:<room>/<thread>` for a room's composer,
 *  `session:<id>` for a session's terminal. */
interface FocusRequest {
  where: string | null;
  nonce: number;
}

export const useFocus = create<FocusRequest>(() => ({ where: null, nonce: 0 }));

/** Asks the composer or terminal at `where` to take focus, now or as soon
 *  as it's shown. */
export const requestFocus = (where: string): void => useFocus.setState((s) => ({ where, nonce: s.nonce + 1 }));

/** Focuses `ref` when focus is asked for at `where`; a request made before
 *  it was shown is taken once it is. */
export const useFocusRequest = (where: string | null, ref: RefObject<{ focus: () => void } | null>): void => {
  const wanted = useFocus((s) => (where !== null && s.where === where ? s.nonce : null));
  useEffect(() => {
    if (wanted === null || !ref.current) return;
    ref.current.focus();
    useFocus.setState((s) => (s.nonce === wanted ? { where: null } : {}));
  });
};
