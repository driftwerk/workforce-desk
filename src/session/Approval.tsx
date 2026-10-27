import { useDesk } from "../hub/store";
import type { Decision, Session } from "../hub/types";

export function Approval({ session, compact = false }: { session: Session; compact?: boolean }) {
  const { hub, fail, open } = useDesk();
  const pending = session.pending;
  if (!pending) return null;
  if (!pending.answerable) {
    return (
      <div className={compact ? "approval approval-compact" : "approval"}>
        <span className="approval-text">
          <b>Needs you in the terminal</b>
          <span>
            {pending.tool}
            {pending.detail ? ` · ${pending.detail}` : ""}
          </span>
        </span>
        {compact && (
          <button type="button" className="btn btn-blocked" onClick={() => open(session.id)}>
            Open
          </button>
        )}
      </div>
    );
  }
  const decide = (d: Decision) => hub?.decide(session.id, pending.id, d).catch(fail);
  return (
    <div className={compact ? "approval approval-compact" : "approval"}>
      {!compact && (
        <span className="approval-text">
          <b>Needs you</b>
          <span>
            {pending.tool}
            {pending.detail ? ` · ${pending.detail}` : ""}
          </span>
        </span>
      )}
      <button type="button" className="btn btn-ghost" onClick={() => decide("deny")}>
        Deny
      </button>
      {!compact && (
        <button type="button" className="btn btn-ghost" onClick={() => decide("terminal")}>
          Ask in terminal
        </button>
      )}
      <button type="button" className="btn btn-blocked" onClick={() => decide("allow")}>
        Allow once
      </button>
    </div>
  );
}
