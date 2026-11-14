import { useEffect, useId, useRef, useState } from "react";
import { HubError } from "../hub/client";
import { SYSTEM_TITLE, type MeWhere } from "../hub/boardSync";
import type { SyncMember } from "../hub/types";
import { Mark } from "../ui/Mark";
import { localSync } from "./syncStore";

const saidOf = (e: unknown): string => (e instanceof HubError || e instanceof Error ? e.message : String(e));

/** Choose who you are on a board's Jira or Linear, when the hub's key is
 *  shared: type part of your name there, pick yourself. Only names and
 *  pictures come back, never emails; the choice is yours alone, kept on
 *  the hub, and goes before your verified email. `chosen`: there's a
 *  choice to clear. */
export function ChooseMe({ where, hub, chosen, onDone, onCancel }: { where: MeWhere; hub: string; chosen: boolean; onDone: () => void; onCancel: () => void }) {
  const title = SYSTEM_TITLE[where.system];
  const [name, setName] = useState("");
  const [found, setFound] = useState<{ name: string; members: SyncMember[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useRef(0);
  const id = useId();
  const typed = name.trim();
  useEffect(() => {
    if (typed.length < 2) return;
    const api = localSync();
    if (!api) return;
    const n = ++run.current;
    const t = setTimeout(() => {
      api
        .membersNamed(where, typed)
        .then((members) => {
          if (run.current === n) {
            setFound({ name: typed, members });
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (run.current === n) setError(saidOf(e));
        });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);
  const keep = async (me: SyncMember | null) => {
    const api = localSync();
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await api.chooseMe(where, me);
      onDone();
    } catch (e) {
      setError(saidOf(e));
    } finally {
      setBusy(false);
    }
  };
  const shown = found && found.name === typed ? found.members : null;
  return (
    <div className="choose-me" role="group" aria-label={`Choose who you are on ${title}`}>
      <label className="field" htmlFor={id}>
        <span>Who are you on {title}?</span>
      </label>
      <input
        id={id}
        className="choose-me-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Part of your name there"
        autoFocus
        spellCheck={false}
        autoComplete="off"
        disabled={busy}
      />
      {typed.length >= 2 && shown && shown.length === 0 && <span className="muted small">No one on {title} has a name with “{typed}” in it.</span>}
      {typed.length >= 2 && shown && shown.length > 0 && (
        <ul className="choose-me-list">
          {shown.map((m) => (
            <li key={m.id}>
              <button type="button" className="choose-me-row" disabled={busy} onClick={() => void keep(m)} aria-label={`I'm ${m.name}`}>
                <Mark name={m.name} size="xs" src={m.avatar ?? null} person tone="series" />
                <span>{m.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <span className="small state-blocked" role="alert">
          {error}
        </span>
      )}
      <span className="muted small">
        {hub} keeps your choice for you alone, and boards go by it for Mine, Assigned to me and Take it.
      </span>
      <span className="choose-me-actions">
        {chosen && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void keep(null)}>
            Go by my email instead
          </button>
        )}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}
