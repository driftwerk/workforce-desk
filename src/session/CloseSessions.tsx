import { useEffect, useState } from "react";
import { lookOf } from "../floor/background";
import { keepOnly, clearSelection } from "../groups/selection";
import { hubFor } from "../hub/store";
import { machineOf, sessionKey } from "../hub/machines";
import type { Closing, Session } from "../hub/types";
import { MachineTag } from "../machines/OnMachine";
import { Confirm } from "../ui/Confirm";
import { homeShort } from "../ui/paths";
import { plainError } from "../ui/plainError";
import { endable } from "./actions";
import { endSessionNow } from "./lifecycle";

/** A picked session, by its sidebar row's key, as the sidebar names it. */
export interface Closable {
  key: string;
  session: Session;
  name: string;
}

/** What its hub said closing it would leave, or that it couldn't say yet. */
type Check = Closing | "checking" | "unread";

/** Why `s` can't be ended from Desk, as End session isn't offered for it. */
export const notEndable = (s: Session): string | null =>
  endable(s) ? null : s.terminalId ? "It runs in one of Desk's terminals: end it there." : "It runs in another terminal: end it there.";

/** What closing it would leave, in a few words each. */
export const leftBehind = (c: Closing): string[] => [
  ...(c.work ? [c.work] : []),
  ...(c.changes ? [c.changes] : []),
  ...c.pulls.map((n) => `PR #${n} still open`),
  ...(c.tickets.length ? [`${c.tickets.join(", ")} still open`] : []),
];

/** Ends `c`'s session as End session does, or why it won't. */
const end = (c: Closable): Promise<void> => {
  const why = notEndable(c.session);
  return why ? Promise.reject(new Error(why)) : endSessionNow(sessionKey(c.session));
};

/** One confirm for closing every picked session: what each would leave, as
 *  its own hub reads it (a machine's on that machine), then each ended as
 *  End session ends one. Those refused stay picked, each saying why. */
export function CloseSessions({ sessions, onClose }: { sessions: Closable[]; onClose: () => void }) {
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [refused, setRefused] = useState<Record<string, string>>({});
  const ids = sessions.map((c) => c.key).join("\n");
  useEffect(() => {
    let current = true;
    for (const c of sessions) {
      const hub = hubFor(c.session);
      setChecks((was) => ({ ...was, [c.key]: hub ? "checking" : "unread" }));
      hub
        ?.closing(c.session.id)
        .then(
          (got): Check => got,
          (): Check => "unread",
        )
        .then((got) => current && setChecks((was) => ({ ...was, [c.key]: got })));
    }
    return () => {
      current = false;
    };
  }, [ids]);

  const close = async () => {
    const tried = await Promise.allSettled(sessions.map(end));
    const now = Object.fromEntries(tried.flatMap((r, i) => (r.status === "rejected" ? [[sessions[i]!.key, plainError(r.reason)]] : [])));
    setRefused(now);
    const left = Object.keys(now).length;
    if (!left) return clearSelection();
    keepOnly((key) => key in now);
    throw new Error(`${left} of ${sessions.length} weren’t closed: each says why.`);
  };

  const n = sessions.length;
  return (
    <Confirm title={`Close ${n} session${n === 1 ? "" : "s"}?`} action={`Close ${n}`} disabled={!n} onConfirm={close} onClose={onClose}>
      <p className="muted">Each is ended as End session ends one: it stops, leaves the sidebar, and you can resume it later from Settings → Sessions.</p>
      <ul className="close-list" aria-label="Sessions to close">
        {sessions.map((c) => (
          <CloseRow key={c.key} c={c} check={checks[c.key] ?? "checking"} refused={refused[c.key] ?? notEndable(c.session)} />
        ))}
      </ul>
    </Confirm>
  );
}

function CloseRow({ c, check, refused }: { c: Closable; check: Check; refused: string | null }) {
  const left = typeof check === "object" ? leftBehind(check) : [];
  const folder = typeof check === "object" ? check.folder : c.session.cwd;
  return (
    <li className="close-row">
      <span className="close-row-head">
        <span className={`dot dot-${lookOf(c.session)}`} aria-hidden="true" />
        <span className="close-row-name mono">{c.name}</span>
        <MachineTag machine={machineOf(c.session)} />
      </span>
      {refused ? (
        <span className="close-row-why small state-blocked">{refused}</span>
      ) : check === "checking" ? (
        <span className="close-row-why small faint">Checking what it would leave…</span>
      ) : check === "unread" ? (
        <span className="close-row-why small faint">What it would leave couldn’t be checked.</span>
      ) : left.length ? (
        <span className="close-row-why small state-blocked">{left.join(" · ")}</span>
      ) : (
        <span className="close-row-why small faint">Nothing left behind.</span>
      )}
      {folder && <span className="close-row-folder small faint mono">{homeShort(folder)}</span>}
    </li>
  );
}
