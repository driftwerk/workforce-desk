import type { ComputerActivityRow, ComputerGrant } from "../hub/client";
import { grantText, outcomeOf, whenText } from "./access";
import "../styles/computer.css";

/** Grants, each with Revoke (Forget, for a session's). */
export function GrantList({
  grants,
  names,
  onRevoke,
  busy,
}: {
  grants: ComputerGrant[];
  names: Record<string, string>;
  onRevoke: (g: ComputerGrant) => void;
  busy: string | null;
}) {
  return (
    <ul className="computer-list">
      {grants.map((g) => (
        <li key={g.id} className="computer-row">
          <span className="computer-row-text">
            <span>
              {names[g.agent] ?? g.agent} · {grantText(g)}
            </span>
            <span className="small faint">
              {g.session_id ? "this session" : `since ${new Date(g.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`}
              {g.run_name ? ` · ${g.run_name}` : ""}
            </span>
          </span>
          <button type="button" className="btn btn-ghost" disabled={busy === g.id} onClick={() => onRevoke(g)}>
            {g.session_id ? "Forget" : "Revoke"}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** What agents did here, newest first, each with what came of it. */
export function ActivityList({ rows, names }: { rows: ComputerActivityRow[]; names: Record<string, string> }) {
  return (
    <ul className="computer-list" aria-label="What agents did here">
      {rows.map((r) => {
        const o = outcomeOf(r);
        return (
          <li key={r.id} className="computer-row">
            <span className="computer-row-text">
              <span className="small faint">
                {whenText(r.at)} · {names[r.agent] ?? r.agent}
                {r.folder ? ` · ${r.folder}` : ""}
              </span>
              <span className="mono small" title={r.doing}>
                {r.doing}
              </span>
            </span>
            <span className={`computer-chip ${o.tone}`}>{o.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

export const EMPTY_ACTIVITY = "Nothing yet. When an agent reads, changes or runs something here, it shows up here.";
