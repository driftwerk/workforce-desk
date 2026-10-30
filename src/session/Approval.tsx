import { useState } from "react";
import { useDesk } from "../hub/store";
import type { Decision, Denied, Session } from "../hub/types";
import { requestFocus } from "../shell/focus";

/** "Bash(cargo test)" → "Bash". */
export const toolName = (tool: string): string => tool.split("(")[0]?.trim() || tool;

/** What allowing a refused tool allows, as its button says: one command,
 *  file or URL where the tool has one (the hub allows just that), else the
 *  whole tool. */
export const allowLabel = (denied: Denied): string => {
  const name = toolName(denied.tool);
  const what = !denied.detail
    ? name
    : ["Bash", "PowerShell", "Monitor"].includes(name)
      ? "this command"
      : ["Edit", "Write", "MultiEdit", "Read", "NotebookEdit"].includes(name)
        ? "this file"
        : name === "WebFetch"
          ? "this URL"
          : name;
  return `Allow ${what} for this session and continue`;
};

/** What a session's turn ended asking the person, with what answers it here:
 *  allowing the tool auto mode refused and carrying on, replying in its
 *  terminal, or leaving it be. */
export function Asked({ session, compact = false }: { session: Session; compact?: boolean }) {
  const { hub, fail } = useDesk();
  const [busy, setBusy] = useState(false);
  const asked = session.asked;
  if (session.state !== "asking" || !asked) return null;
  const denied = asked.denied;
  const run = (act: "allowAsked" | "dismissAsked") => () => {
    if (busy || !hub) return;
    setBusy(true);
    hub[act](session.id)
      .catch(fail)
      .finally(() => setBusy(false));
  };
  return (
    <div className={compact ? "approval approval-compact" : "approval"} role="group" aria-label={`${session.name} asked`}>
      <span className="approval-text">
        <b>Needs you · asked</b>
        <span>{asked.ask}</span>
        {!compact && (denied?.detail || asked.why) && <span className="faint">{denied?.detail ? `${denied.detail} · ${denied.reason}` : asked.why}</span>}
      </span>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={run("dismissAsked")}>
        Dismiss
      </button>
      {!compact && (
        <button type="button" className="btn btn-ghost" onClick={() => requestFocus(`session:${session.id}`)}>
          Reply…
        </button>
      )}
      {denied?.allowable && (
        <button
          type="button"
          className="btn btn-blocked"
          disabled={busy}
          title={denied.detail ? `Only ${denied.detail}, until the session ends` : "Until the session ends"}
          onClick={run("allowAsked")}
        >
          {allowLabel(denied)}
        </button>
      )}
    </div>
  );
}

export function Approval({ session, compact = false }: { session: Session; compact?: boolean }) {
  const { hub, fail, open } = useDesk();
  const pending = session.pending;
  if (!pending) return <Asked session={session} compact={compact} />;
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
