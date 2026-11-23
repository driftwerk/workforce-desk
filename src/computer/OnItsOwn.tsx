import { useCallback, useEffect, useState } from "react";
import type { Agent } from "../chat/types";
import { HubError, type ComputerActivityRow, type OnItsOwnKind, type OnItsOwnLevel, type OnItsOwnRow, type OnItsOwnScope } from "../hub/client";
import { useDesk } from "../hub/store";
import { useUi } from "../shell/ui";
import { plainError } from "../ui/plainError";
import { pickFolder } from "../platform";
import { tilde } from "../machines/folders";
import { ALONE, RECENT, choicesFor, levelFor, overridesFor, siteText, typedOverride } from "./access";
import { ActivityList } from "./Lists";
import "../styles/computer.css";

const scopeOf = (by: "folder" | "host" | "site", value: string): OnItsOwnScope => ({ kind: by, value });

/** What the agent does without asking, kind by kind, with the folders,
 *  machines and sites it does it in; what it did on its own lately; and
 *  "Ask me again", which forgets all of it and every "Always allow".
 *  Only at Full access asking before irreversible things: below it the
 *  levels wait, and "Do anything" already asks nothing. */
export function OnItsOwn({
  agent,
  applies,
  everything,
  home,
  onAskedAgain,
}: {
  agent: Agent;
  applies: boolean;
  everything: boolean;
  home: string | null;
  onAskedAgain: () => void;
}) {
  const hub = useDesk((s) => s.hub);
  const [rows, setRows] = useState<OnItsOwnRow[] | null | "failed" | "old">(null);
  const [done, setDone] = useState<ComputerActivityRow[] | null | "failed">(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!hub) return;
    hub
      .onItsOwn(agent.id)
      .then(setRows)
      .catch((e: unknown) => setRows(e instanceof HubError && e.status === 404 ? "old" : "failed"));
    hub
      .computerActivity({ agent: agent.id, decided_by: "on_its_own" })
      .then((p) => setDone(p.rows.slice(0, RECENT)))
      .catch(() => setDone("failed"));
  }, [hub, agent.id]);
  useEffect(reload, [reload]);

  const change = async (kind: OnItsOwnKind, scope: OnItsOwnScope, level: OnItsOwnLevel | null) => {
    if (!hub || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await hub.setOnItsOwn(agent.id, kind, scope, level);
      reload();
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };
  const askAgain = async () => {
    if (!hub || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await hub.askAgain(agent.id);
      reload();
      onAskedAgain();
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };
  const names = { [agent.id]: agent.name };
  const set = Array.isArray(rows) ? rows : [];

  return (
    <>
      <section className="agent-section" aria-labelledby="computer-alone-head">
        <div className="ability-head">
          <h2 id="computer-alone-head">What {agent.name} does on its own</h2>
          <button type="button" className="btn" disabled={busy || !Array.isArray(rows)} onClick={() => void askAgain()}>
            Ask me again
          </button>
        </div>
        {!everything && (
          <p className="small faint">
            On its own, it doesn’t ask you first. Passwords and sign-ins, payments, sending to people, this computer’s own settings, commands Desk can’t read and deletes it can’t tell always ask.
            Everything it does is in the audit, and Stop still stops it.
          </p>
        )}
        <p className="small faint">Ask me again: Desk asks you about everything again and forgets what is always allowed for {agent.name}.</p>
        {!applies && !everything && <p className="ability-note small">These apply at Full access, asking only before irreversible things.</p>}
        {everything ? (
          <p className="ability-note small">Does everything on its own.</p>
        ) : rows === "old" ? (
          <p className="small faint">This version of Desk can’t do that yet. Update Desk to use it.</p>
        ) : rows === "failed" ? (
          <p className="small state-blocked">Couldn’t read what {agent.name} does on its own just now.</p>
        ) : rows === null ? (
          <p className="small faint">Reading…</p>
        ) : (
          <div className="ability-card">
            {ALONE.map((k) => (
              <KindRow
                key={k.id}
                kind={k}
                level={levelFor(set, k.id)}
                overrides={overridesFor(set, k.id)}
                home={home}
                disabled={busy || !applies}
                onLevel={(level) => void change(k.id, { kind: "whole" }, level)}
                onOverride={(value, on) => void change(k.id, scopeOf(k.by, value), on ? "anywhere" : null)}
                onProblem={setProblem}
              />
            ))}
          </div>
        )}
        {problem && (
          <p className="small state-blocked" role="alert">
            {problem}
          </p>
        )}
      </section>

      <section className="agent-section" aria-labelledby="computer-alone-done-head">
        <div className="ability-head">
          <h2 id="computer-alone-done-head">Done on its own</h2>
          <button type="button" className="link small" onClick={() => useUi.getState().openSettings("computer")}>
            See full audit
          </button>
        </div>
        {done === "failed" ? (
          <p className="small state-blocked">Couldn’t read what {agent.name} did on its own just now.</p>
        ) : done === null ? (
          <p className="small faint">Reading…</p>
        ) : done.length === 0 ? (
          <p className="pane-empty small">Nothing yet. What {agent.name} does without asking shows here.</p>
        ) : (
          <ActivityList rows={done} names={names} label={`What ${agent.name} did on its own`} />
        )}
      </section>
    </>
  );
}

/** One kind: its level, and the folders, machines or sites it does it in
 *  on its own, each removable, with a way to add one. */
function KindRow({
  kind,
  level,
  overrides,
  home,
  disabled,
  onLevel,
  onOverride,
  onProblem,
}: {
  kind: (typeof ALONE)[number];
  level: OnItsOwnLevel | null;
  overrides: string[];
  home: string | null;
  disabled: boolean;
  onLevel: (level: OnItsOwnLevel | null) => void;
  onOverride: (value: string, on: boolean) => void;
  onProblem: (problem: string | null) => void;
}) {
  const [typed, setTyped] = useState("");
  const shown = (value: string) => (kind.by === "site" ? siteText(value) : kind.by === "folder" ? tilde(value, home) : value);
  const add = async () => {
    if (kind.by === "folder") {
      const picked = await pickFolder();
      if (picked) onOverride(picked, true);
      return;
    }
    const { value, problem } = typedOverride(kind.by, typed);
    onProblem(problem);
    if (!value) return;
    onOverride(value, true);
    setTyped("");
  };
  const placeholder = kind.by === "host" ? "devbox or 10.0.1.20" : "github.com";

  return (
    <div className="ability-row alone-row">
      <span className="ability-text">
        <b>{kind.title}</b>
        <span className="ability-sub">{kind.line}</span>
        {overrides.length > 0 && (
          <ul className="computer-list" aria-label={`Where it does “${kind.title}” on its own`}>
            {overrides.map((o) => (
              <li key={o} className="computer-row">
                <span className="computer-row-text">
                  <span className="mono small">{shown(o)}</span>
                </span>
                <button type="button" className="btn btn-ghost" disabled={disabled} aria-label={`Ask again for ${shown(o)}`} onClick={() => onOverride(o, false)}>
                  Ask again
                </button>
              </li>
            ))}
          </ul>
        )}
        {level !== "anywhere" && (
          <span className="alone-add">
            {kind.by !== "folder" && (
              <input
                className="field-text mono"
                value={typed}
                placeholder={placeholder}
                aria-label={kind.by === "host" ? "A machine it reaches on its own" : "A site it uses on its own"}
                disabled={disabled}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void add();
                }}
              />
            )}
            <button type="button" className="btn btn-ghost" disabled={disabled || (kind.by !== "folder" && !typed.trim())} onClick={() => void add()}>
              {kind.by === "folder" ? "Add a folder…" : kind.by === "host" ? "Add a machine" : "Add a site"}
            </button>
          </span>
        )}
      </span>
      <div className="seg" role="radiogroup" aria-label={`${kind.title}: when it asks`}>
        {choicesFor(kind.by).map((c) => (
          <button key={c.label} type="button" role="radio" aria-checked={level === c.id} disabled={disabled} onClick={() => level !== c.id && onLevel(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
