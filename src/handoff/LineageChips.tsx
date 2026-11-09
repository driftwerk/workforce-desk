// Where a session's work came from and went (session memory §8.5): on the
// session it went on in, "continued from Claude Code · 10:42", opening that
// one, and Hand back where the one it came from can be resumed; on the one
// it left, "continued in Codex · 10:42 → Open" and that the work goes on
// there. Read from the hub's lineage, which costs no model call.

import { useEffect } from "react";
import { ENGINE_TITLE } from "../engines/engines";
import { machineOf, LOCAL } from "../hub/machines";
import { useDesk } from "../hub/store";
import type { Session } from "../hub/types";
import { resumable } from "../session/actions";
import { askHandoff, useHandoff } from "./store";
import { continuedFrom, continuedIn } from "./words";

/** Whether Continue in… is offered for `s`: this computer's sessions only
 *  (a machine's work moves between machines, which is still to come). */
export const canHandOff = (s: Pick<Session, "machine">): boolean => machineOf(s) === LOCAL;

export function LineageChips({ session }: { session: Session }) {
  const here = canHandOff(session);
  const lineage = useHandoff((s) => s.lineage[session.id]);
  const told = useHandoff((s) => s.told[session.id]);
  const load = useHandoff((s) => s.loadLineage);
  const open = useDesk((s) => s.open);
  const from = useDesk((s) => (lineage?.from ? s.sessions[lineage.from.session] : undefined));
  // Read again as it settles: a handoff ends or starts a session.
  const settled = session.live ? "live" : session.state;
  useEffect(() => {
    if (here) void load(session.id);
  }, [here, load, session.id, settled]);
  if (!here || !lineage) return null;
  // The work can go back where it came from while that one can be resumed;
  // the hub's preview says the rest.
  const backOffered = !!lineage.from && !lineage.handedTo && !!from && resumable(from);
  return (
    <div className="lineage-bar small" aria-label="Where this work came from and went">
      {lineage.from && (
        <span className="lineage-item">
          <button type="button" className="chip lineage-chip" title={`Open ${lineage.from.name}`} onClick={() => open(lineage.from!.session)}>
            <SwapIcon />
            {continuedFrom(lineage.from)}
          </button>
          {backOffered && (
            <button type="button" className="link small" onClick={() => askHandoff({ id: session.id, back: true })}>
              Hand back
            </button>
          )}
        </span>
      )}
      {lineage.handedTo && (
        <span className="lineage-item">
          <span className="chip lineage-chip">
            <SwapIcon />
            {continuedIn(lineage.handedTo)}
          </span>
          <span className="muted">This work continues in {ENGINE_TITLE[lineage.handedTo.engine]}.</span>
          <button type="button" className="link small" onClick={() => open(lineage.handedTo!.session)}>
            Open {lineage.handedTo.name} →
          </button>
        </span>
      )}
      {told && (
        <span className="lineage-told">
          {told.said}
          {told.notes.map((n) => (
            <span key={n} className="faint">
              {" "}
              {n}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

export const SwapIcon = () => (
  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M2 4.5h9M8.5 2l2.5 2.5L8.5 7M12 9.5H3M5.5 7L3 9.5 5.5 12" />
  </svg>
);
