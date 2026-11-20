import { useState } from "react";
import { hubOf } from "../hub/store";
import { machineOf, type MachineId } from "../hub/machines";
import type { LineAction, LineMessage, Session } from "../hub/types";
import { dayClock, since } from "../floor/time";
import { plainError } from "../ui/plainError";
import { editable, headOf } from "./rows";
import { useLine } from "./store";

/** Why `m` hasn't gone into `session` yet, and when it will, in plain
 *  words; `now` for how long it has waited. */
export const whyWaiting = (m: LineMessage, session: Session, now = Date.now()): string => {
  const name = session.displayName ?? session.name;
  const waited = since(m.at, now);
  const forHow = waited && waited !== "just now" ? ` It has waited ${waited}.` : "";
  if (m.delivery === "handed")
    return `Handed to its terminal: it goes in as soon as ${name} takes it.`;
  if (m.delivery === "held") return `${name} isn't running: this goes in when it runs again.${forHow}`;
  switch (m.waiting) {
    case "working":
      return `${name} is in the middle of a turn: this goes in when that turn ends.${forHow}`;
    case "next_call":
      return `Sent now: ${name} reads this with its next tool call's result, or when its turn ends if no call comes first.`;
    case "stopped":
      return `${name} isn't running: this goes in when it runs again.${forHow}`;
    case "typing":
      return `You're typing in its terminal: this goes in once you've sent or cleared what you typed.${forHow}`;
    case "paused":
      return `Desk's breaker paused ${name}: only your own messages go in until you let it go on.${forHow}`;
    case "asking":
      return `${name}'s turn ended asking you something: this goes in once you've answered it.${forHow}`;
    case "dialog":
      return `${name} waits on a dialog in its terminal: this goes in after it is answered and its turn ends.${forHow}`;
    case "person_driving":
      return `You're driving ${name}: its boss's messages go in once you hand it back.${forHow}`;
    case "mode_ending":
      return `Desk is starting ${name} again in its own mode: this goes in after that.${forHow}`;
    default:
      return `This goes in as soon as ${name} can take it.${forHow}`;
  }
};

/** Whether the person can do `a` with `m` now: as the hub says per row, or,
 *  from an older hub that doesn't say, change or take back their own. */
export const can = (m: LineMessage, a: LineAction): boolean => (m.actions ? m.actions.includes(a) : a !== "send_now" && editable(m));

/** The messages waiting to go into a session, each in full: who sent it and
 *  when, its words, why it waits, and what can be done with it. */
export function WaitingMessages({ session, waiting, now }: { session: Session; waiting: LineMessage[]; now: number }) {
  return (
    <ol className="line-thread line-waiting">
      {waiting.map((m) => (
        <Waiting key={m.id} m={m} session={session} now={now} machine={machineOf(session)} />
      ))}
    </ol>
  );
}

function Waiting({ m, session, now, machine }: { m: LineMessage; session: Session; now: number; machine: MachineId }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const act = async (f: () => Promise<void>) => {
    const hub = hubOf(machine);
    if (!hub) return;
    setBusy(true);
    setProblem(null);
    try {
      await f();
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };
  const save = () => {
    const text = editing?.trim();
    if (!text || text === m.text) return setEditing(null);
    void act(async () => {
      await hubOf(machine)!.editLine(m.id, text);
      setEditing(null);
    });
  };
  return (
    <li className="line-row line-row-waiting">
      <span className="line-row-head small">
        <span className="strong">{headOf(m, session.id)}</span>
        <span className="faint"> · {dayClock(m.at, now)}</span>
      </span>
      {editing === null ? (
        <span className="line-row-text line-waiting-text">{m.text}</span>
      ) : (
        <textarea
          className="field-text line-waiting-edit"
          rows={3}
          autoFocus
          value={editing}
          aria-label="Edit your message"
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setEditing(null);
            }
          }}
        />
      )}
      <span className="small muted line-waiting-why">{whyWaiting(m, session, now)}</span>
      <span className="line-waiting-actions">
        {editing !== null ? (
          <>
            <button type="button" className="btn btn-signal btn-sm" disabled={busy || !editing.trim()} onClick={save}>
              Save
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {can(m, "send_now") && (
              <button
                type="button"
                className="btn btn-signal btn-sm"
                disabled={busy}
                title="Into its running turn now: it reads this with its next tool call's result"
                onClick={() =>
                  void act(async () => {
                    useLine.getState().heard(await hubOf(machine)!.sendLineNow(m.id), false, machine);
                  })
                }
              >
                Send now
              </button>
            )}
            {can(m, "edit") && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setEditing(m.text)}>
                Edit
              </button>
            )}
            {can(m, "withdraw") && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                title="Take it back: it never goes in"
                onClick={() => void act(() => hubOf(machine)!.takeBackLine(m.id))}
              >
                Withdraw
              </button>
            )}
          </>
        )}
      </span>
      {problem && (
        <span className="small state-blocked" role="alert">
          {problem}
        </span>
      )}
    </li>
  );
}
