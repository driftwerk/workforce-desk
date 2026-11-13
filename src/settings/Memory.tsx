import { useCallback, useEffect, useId, useRef, useState } from "react";
import { deskListeners, useDesk } from "../hub/store";
import type { DeskEvent, MemoryChoice, MemoryIndexStatus, MemorySettings } from "../hub/types";
import { clock, count, providerName, thousands } from "../memory/words";
import { plainError } from "../ui/plainError";
import { SwitchRow } from "../ui/SwitchRow";

/** What the index says of itself, in plain words. */
export const indexLines = (i: MemoryIndexStatus): string[] => {
  if (!i.installed) return ["Search by meaning isn't set up on this computer, so Desk searches what it remembers by keyword."];
  return [
    i.failing ? "Desk Memory's search isn't answering, so Desk searches by keyword until it does." : i.caughtUp ? `Up to date as of ${clock(i.caughtUp)}.` : null,
    i.backlog > 0 ? `${count(i.backlog, "exchange")} waiting to be added to search; until then they're found by keyword.` : null,
    i.setAside > 0 ? `${count(i.setAside, "exchange")} search kept refusing, set aside: they're found by keyword.` : null,
    i.purgesSetAside > 0 ? `Some conversations you asked Desk to forget are still in its search. Rebuild it to clear them.` : null,
  ].filter((l): l is string => !!l);
};

/** Settings → Memory: the pause, how much is kept and where, the search
 *  index and rebuilding it, and the install's limits. */
export function Memory() {
  const hub = useDesk((s) => s.hub);
  const [settings, setSettings] = useState<MemorySettings | null | undefined>(undefined);
  const [index, setIndex] = useState<MemoryIndexStatus | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [rebuilt, setRebuilt] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  // Each part on its own: one that fails says why, and the other still shows.
  const load = useCallback(async () => {
    if (!hub) return;
    const problems: string[] = [];
    await Promise.all([
      hub.memorySettings().then(setSettings, (e: unknown) => {
        setSettings(null);
        problems.push(plainError(e));
      }),
      hub.memoryIndex().then(setIndex, (e: unknown) => {
        setIndex(null);
        problems.push(plainError(e));
      }),
    ]);
    setProblem(problems.length ? problems.join(" ") : null);
  }, [hub]);
  useEffect(() => {
    void load();
    const heard = (e: DeskEvent) => {
      if (e.type === "setting") void load();
    };
    deskListeners.add(heard);
    return () => void deskListeners.delete(heard);
  }, [load]);

  const pause = async (paused: boolean) => {
    try {
      const now = await hub!.pauseMemory(paused);
      setSettings(now);
      setProblem(now.notice ?? null);
    } catch (e) {
      setProblem(plainError(e));
    }
  };
  const [saving, setSaving] = useState<keyof MemoryChoice | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const choose = async (change: MemoryChoice) => {
    setSaving(Object.keys(change)[0] as keyof MemoryChoice);
    try {
      const now = await hub!.chooseMemory(change);
      setSettings(now);
      setSaid(now.notice ?? null);
      setProblem(null);
    } catch (e) {
      setProblem(plainError(e));
    } finally {
      setSaving(null);
    }
  };
  // Keeping conversations for less: how many go, confirmed first.
  const [shrink, setShrink] = useState<{ days: number; exchanges: number } | null>(null);
  const chooseDays = async (days: number) => {
    if (!settings || days >= settings.limits.retainDays) return choose({ retainDays: days });
    try {
      const p = await hub!.memoryRetainPreview(days);
      if (p.exchanges === 0) return choose({ retainDays: days });
      setShrink({ days, exchanges: p.exchanges });
    } catch (e) {
      setProblem(plainError(e));
    }
  };
  const rebuild = async () => {
    setRebuilding(true);
    try {
      const queued = await hub!.rebuildMemoryIndex();
      setRebuilt(`Rebuilding: ${count(queued, "exchange")} to add again. Until then, what isn't back yet is found by keyword.`);
      setProblem(null);
      await load();
    } catch (e) {
      setProblem(plainError(e));
    } finally {
      setRebuilding(false);
    }
  };

  const totals = settings?.totals ?? [];
  const all = totals.reduce((a, t) => ({ sessions: a.sessions + t.sessions, exchanges: a.exchanges + t.exchanges, notes: a.notes + t.notes, secrets: a.secrets + t.secretsHidden }), {
    sessions: 0,
    exchanges: 0,
    notes: 0,
    secrets: 0,
  });
  const groupName = (id: string | null) => (id === null ? "Ungrouped" : (settings?.groups.find((g) => g.id === id)?.name ?? "A group Desk no longer has"));
  const limits = settings?.limits;

  return (
    <section className="settings-pane memory-settings" aria-label="Memory">
      <h1 className="display-lg">Memory</h1>
      <p className="muted">What Desk remembers of your sessions: what they said and did, with secrets hidden, kept on this computer to search and to pick up later.</p>
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      {settings === undefined ? (
        <p className="faint small">Loading…</p>
      ) : settings === null ? (
        !problem && <p className="muted small">This version of Desk doesn't keep Desk Memory's settings yet. Update Desk to change them.</p>
      ) : (
        <>
          <SwitchRow
            label="Pause remembering"
            sub={
              settings.paused
                ? "Paused: nothing any session says now is kept, and it isn't read later either."
                : "Desk is remembering your sessions. Paused, nothing they say meanwhile is kept."
            }
            on={settings.paused}
            onChange={(paused) => void pause(paused)}
          />

          <section className="prov-section" aria-label="What Desk keeps">
            <h2 className="field-label">What Desk keeps</h2>
            <p className="small">
              {[count(all.exchanges, "exchange"), `from ${count(all.sessions, "session")}`].join(" ")} · {count(all.notes, "note")} · {count(all.secrets, "secret")} hidden
              {index?.diskMb != null && ` · ${thousands(index.diskMb)} MB of ${thousands(index.maxDiskMb)} MB`}
            </p>
            {totals.length > 0 && (
              <div className="hub-list">
                {totals.map((t) => (
                  <div key={t.group ?? ""} className="hub-row">
                    <span className="hub-name">
                      <b>{groupName(t.group)}</b>
                      <span className="faint small">
                        {count(t.exchanges, "exchange")} from {count(t.sessions, "session")} · {count(t.notes, "note")}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {index !== undefined && (
        <section className="prov-section" aria-label="Search">
          <h2 className="field-label">Search</h2>
          {index === null ? (
            <p className="small muted">Desk Memory has no search index here yet, so Desk searches by keyword.</p>
          ) : (
            <>
              {indexLines(index).map((l) => (
                <p key={l} className="small muted">
                  {l}
                </p>
              ))}
              {index.installed && (
                <div>
                  <button type="button" className="btn" disabled={rebuilding} onClick={() => void rebuild()}>
                    {rebuilding ? "Rebuilding…" : "Rebuild search"}
                  </button>
                </div>
              )}
              {rebuilt && (
                <p className="small muted" role="status">
                  {rebuilt}
                </p>
              )}
            </>
          )}
        </section>
      )}

      {limits && (
        <section className="prov-section" aria-label="What Desk remembers">
          <h2 className="field-label">What Desk remembers</h2>
          <SwitchRow
            label="Remember conversations"
            sub={
              limits.enabled
                ? "Desk keeps what your sessions say and do, to search and to pick up later."
                : "Off: Desk keeps nothing new from any session until it's on again."
            }
            on={limits.enabled}
            saving={saving === "enabled"}
            onChange={(enabled) => void choose({ enabled })}
          />
          <SwitchRow
            label="Note decisions, facts and to-dos"
            sub={
              !limits.enabled
                ? "Comes on with remembering conversations."
                : limits.derive
                  ? `Desk's model reads what sessions say and notes them, at most ${count(limits.deriveCallsPerDay, "time")} a day (${thousands(limits.deriveCallsToday)} so far today)${limits.provider ? `, on ${providerName(limits.provider)}` : ""}.`
                  : "Off: nothing a session says is sent to a model to note."
            }
            on={limits.enabled && limits.derive}
            disabled={!limits.enabled}
            saving={saving === "derive"}
            onChange={(derive) => void choose({ derive })}
          />
          <NumberChoice
            label="Keep conversations for"
            unit="days"
            value={limits.retainDays}
            min={1}
            max={3650}
            note="After they end; notes stay until you forget them."
            saving={saving === "retainDays"}
            onChange={(retainDays) => void chooseDays(retainDays)}
          />
          {shrink && (
            <div className="memory-confirm" role="alertdialog" aria-label="Keep conversations for less">
              <span className="small">
                This deletes conversations older than {count(shrink.days, "day")} (about {count(shrink.exchanges, "exchange")}) the next time Desk tidies up.
              </span>
              <span className="field-row">
                <button
                  type="button"
                  className="btn btn-sm btn-blocked"
                  onClick={() => {
                    const days = shrink.days;
                    setShrink(null);
                    void choose({ retainDays: days });
                  }}
                >
                  Delete them
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setShrink(null)}>
                  Keep them
                </button>
              </span>
            </div>
          )}
          <NumberChoice
            label="Room for Desk Memory"
            unit="MB"
            value={limits.maxDiskMb}
            min={100}
            max={1_000_000}
            note="When it's full, Desk stops remembering until there's room."
            saving={saving === "maxDiskMb"}
            onChange={(maxDiskMb) => void choose({ maxDiskMb })}
          />
          {said && (
            <p className="small muted" role="status">
              {said}
            </p>
          )}
          <ul className="memory-limits small faint">
            <li>On its first read, Desk goes back {count(limits.backfillDays, "day")}.</li>
            <li>Search takes in up to {thousands(limits.indexPerMinute)} passages a minute.</li>
          </ul>
        </section>
      )}
    </section>
  );
}

/** A number the person sets, kept once they leave the field or press
 *  Enter, and only when it's one Desk can work with. */
function NumberChoice({
  label,
  unit,
  value,
  min,
  max,
  note,
  saving,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  note: string;
  saving?: boolean;
  onChange: (n: number) => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState(String(value));
  useEffect(() => setTyped(String(value)), [value]);
  const n = Number(typed);
  const fits = Number.isInteger(n) && n >= min && n <= max;
  // Enter, then leaving the field, asks once.
  const asked = useRef<number | null>(null);
  useEffect(() => {
    asked.current = null;
  }, [value]);
  const keep = () => {
    if (!fits) return setTyped(String(value));
    if (n === value || n === asked.current) return;
    asked.current = n;
    onChange(n);
  };
  return (
    <div className="ability-row">
      <label className="ability-text" htmlFor={id}>
        <b>{label}</b>
        <span className="ability-sub">
          {fits ? note : `Between ${thousands(min)} and ${thousands(max)} ${unit}.`}
        </span>
      </label>
      <span className="field-row memory-number">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={typed}
          aria-invalid={!fits}
          disabled={saving}
          onWheel={(e) => e.currentTarget.blur()}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={keep}
          onKeyDown={(e) => e.key === "Enter" && keep()}
        />
        <span className="small muted">{unit}</span>
      </span>
    </div>
  );
}
