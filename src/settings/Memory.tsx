import { useCallback, useEffect, useId, useState } from "react";
import { deskListeners, useDesk } from "../hub/store";
import type { DeskEvent, MemoryIndexStatus, MemorySettings } from "../hub/types";
import { clock, count, providerName, thousands } from "../memory/words";
import { plainError } from "../ui/plainError";

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
  const pauseId = useId();

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
        !problem && <p className="muted small">This computer's hub doesn't keep Desk Memory's settings yet.</p>
      ) : (
        <>
          <div className="ability-row">
            <span className="ability-text">
              <b id={pauseId}>Pause remembering</b>
              <span className="ability-sub">
                {settings.paused
                  ? "Paused: nothing any session says now is kept, and it isn't read later either."
                  : "Desk is remembering your sessions. Paused, nothing they say meanwhile is kept."}
              </span>
            </span>
            <button type="button" role="switch" className="switch" aria-checked={settings.paused} aria-labelledby={pauseId} onClick={() => void pause(!settings.paused)}>
              <span className="switch-knob" />
            </button>
          </div>

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
            <p className="small muted">This computer's hub has no search index for Desk Memory; Desk searches by keyword.</p>
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
        <section className="prov-section" aria-label="Limits">
          <h2 className="field-label">Limits</h2>
          <p className="faint small">These limits are set in Desk’s memory settings file. Ask Desk to change them.</p>
          <ul className="memory-limits small">
            {!limits.enabled && <li>Remembering conversations is turned off for this Desk.</li>}
            <li>Conversations are kept {count(limits.retainDays, "day")} after they end; notes stay until you forget them.</li>
            <li>On its first read, Desk goes back {count(limits.backfillDays, "day")}.</li>
            <li>Desk Memory may use up to {thousands(limits.maxDiskMb)} MB; when it's full, it stops remembering until there's room.</li>
            <li>Search takes in up to {thousands(limits.indexPerMinute)} passages a minute.</li>
            <li>
              {limits.derive
                ? `Desk's model notes decisions at most ${count(limits.deriveCallsPerDay, "time")} a day (${thousands(limits.deriveCallsToday)} so far today)${limits.provider ? `, on ${providerName(limits.provider)}` : ""}.`
                : "Noting decisions, facts and to-dos is turned off for this Desk."}
            </li>
          </ul>
        </section>
      )}
    </section>
  );
}
