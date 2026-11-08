import { useFloor } from "../floor/store";
import type { Gist, Work } from "../hub/types";

/** What the Floor last said a session is for and where it is: the latest
 *  turn of its that its hub wrote a gist of, on any hub's floor. */
export const gistOf = (hubs: ReturnType<typeof useFloor.getState>["hubs"], session: string): Gist | null => {
  let best: Gist | null = null;
  for (const h of Object.values(hubs)) {
    const works: Work[] = [...(h.floor?.working ?? []), ...(h.floor?.done ?? [])];
    for (const w of works) {
      if (w.who.kind !== "session" || w.who.id !== session || !w.gist) continue;
      if (!best || w.gist.at > best.at) best = w.gist;
    }
  }
  return best;
};

/** The session's gist, as the Floor has it. */
export const useSessionGist = (session: string): Gist | null => useFloor((s) => gistOf(s.hubs, session));
