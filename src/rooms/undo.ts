import { useState } from "react";
import { useDesk } from "../hub/store";
import { HubError } from "../hub/client";
import { plainError } from "../ui/plainError";
import type { DecisionLine } from "../hub/types";

// Undoing what the boss did, wherever its line is drawn.

/** What came of an undo, by decision, for as long as Desk runs: a line
 *  drawn again says so at once. */
const undoneHere = new Map<string, string>();

export const UNDO_LABEL: Record<NonNullable<DecisionLine["undo"]>, string> = {
  undo: "Undo",
  correct: "Correct",
  stop: "Stop it",
  resume: "Resume",
};

/** Undoing decision `id`: what came of it (kept for as long as Desk
 *  runs), whether it can't be after all, and the hub's problem. */
export function useUndo(id: string, undoneAlready: boolean) {
  const [undone, setUndone] = useState<string | null>(undoneHere.get(id) ?? null);
  // A decision that can't be undone after all: no button to press again.
  const [fixed, setFixed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const done = (said: string) => {
    undoneHere.set(id, said);
    setUndone(said);
  };
  const undo = async () => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await hub.undoDecision(id);
      done(r?.done ?? "");
    } catch (e) {
      // Undone already elsewhere, or gone with its session: it shows so.
      if (e instanceof HubError && (e.status === 409 || e.status === 404)) done("");
      else {
        if (e instanceof HubError && e.status === 400) setFixed(true);
        setProblem(plainError(e));
      }
    }
    setBusy(false);
  };
  // Undone here, or elsewhere as the message now says.
  return { undone, isUndone: undone !== null || undoneAlready, fixed, busy, problem, undo };
}
