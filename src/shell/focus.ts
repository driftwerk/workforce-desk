import { useEffect, type RefObject } from "react";
import { create } from "zustand";

/** Where the person asked to type next: `agent:<hub>/<agent>` for a DM,
 *  `room:<room>` or `room:<room>/<thread>` for a room's composer,
 *  `session:<id>` for a session's terminal. */
interface FocusRequest {
  where: string | null;
  nonce: number;
  /** Text for the composer to add to what's typed (Ask… on a message). */
  insert: string | null;
}

export const useFocus = create<FocusRequest>(() => ({ where: null, nonce: 0, insert: null }));

/** Asks the composer or terminal at `where` to take focus, now or as soon
 *  as it's shown, adding `insert` to what's typed there. */
export const requestFocus = (where: string, insert?: string): void =>
  useFocus.setState((s) => ({ where, nonce: s.nonce + 1, insert: insert ?? null }));

/** Focuses `ref` when focus is asked for at `where`, handing `onInsert`
 *  any text the request carries; a request made before it was shown is
 *  taken once it is. */
export const useFocusRequest = (
  where: string | null,
  ref: RefObject<{ focus: () => void } | null>,
  onInsert?: (text: string) => void,
): void => {
  const wanted = useFocus((s) => (where !== null && s.where === where ? s.nonce : null));
  useEffect(() => {
    if (wanted === null || !ref.current) return;
    const insert = useFocus.getState().insert;
    if (insert && onInsert) onInsert(insert);
    ref.current.focus();
    useFocus.setState((s) => (s.nonce === wanted ? { where: null, insert: null } : {}));
  });
};
