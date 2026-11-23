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
import { plural } from "../unread/rows";
import { endable, runs, runsElsewhere } from "./actions";
import { endSessionNow, removeSession } from "./lifecycle";

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

/** Does `act` to every picked session at once. All done, the selection is
 *  let go; otherwise only those refused stay picked, each saying why. */
export async function settle(sessions: readonly Closable[], act: (c: Closable) => Promise<unknown>, done: string, said: (refused: Record<string, string>) => void): Promise<void> {
  const tried = await Promise.allSettled(sessions.map(act));
  const refused = Object.fromEntries(tried.flatMap((r, i) => (r.status === "rejected" ? [[sessions[i]!.key, plainError(r.reason)]] : [])));
  said(refused);
  const left = Object.keys(refused).length;
  if (!left) return clearSelection();
  keepOnly((key) => key in refused);
  throw new Error(`${left} of ${sessions.length} weren’t ${done}: each says why.`);
}

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

  const n = sessions.length;
  return (
    <Confirm title={`Close ${plural(n, "session")}?`} action={`Close ${n}`} disabled={!n} onConfirm={() => settle(sessions, end, "closed", setRefused)} onClose={onClose}>
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
  const why: Why = refused
    ? { text: refused, warn: true }
    : check === "checking"
      ? { text: "Checking what it would leave…" }
      : check === "unread"
        ? { text: "What it would leave couldn’t be checked." }
        : left.length
          ? { text: left.join(" · "), warn: true }
          : { text: "Nothing left behind." };
  return <PickedRow c={c} why={why} folder={folder} />;
}

/** What a picked session's row says about it: a warning, or a quiet note. */
interface Why {
  text: string;
  warn?: boolean;
}

/** A picked session in a confirm's list: its dot, name and machine, then
 *  what the confirm says about it, and where it works. */
function PickedRow({ c, why, folder }: { c: Closable; why: Why | null; folder?: string | null }) {
  return (
    <li className="close-row">
      <span className="close-row-head">
        <span className={`dot dot-${lookOf(c.session)}`} aria-hidden="true" />
        <span className="close-row-name mono">{c.name}</span>
        <MachineTag machine={machineOf(c.session)} />
      </span>
      {why && <span className={`close-row-why small ${why.warn ? "state-blocked" : "faint"}`}>{why.text}</span>}
      {folder && <span className="close-row-folder small faint mono">{homeShort(folder)}</span>}
    </li>
  );
}

/** What removing `c` does that it should know, or why it wasn't. */
const removeWhy = (c: Closable, refused: string | undefined): Why | null =>
  refused
    ? { text: refused, warn: true }
    : c.session.live
      ? { text: "Running: it stops, and its transcript is kept." }
      : runsElsewhere(c.session)
        ? { text: "Runs in its own terminal: it keeps running there, and Desk stops tracking it." }
        : null;

/** One confirm for removing every picked session, as Remove removes one:
 *  Desk forgets each, and deletes the transcripts of those not running when
 *  asked. Those refused stay picked, each saying why. */
export function RemoveSessions({ sessions, onClose }: { sessions: Closable[]; onClose: () => void }) {
  const [transcripts, setTranscripts] = useState(false);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const running = sessions.filter((c) => runs(c.session)).length;
  const stopping = sessions.filter((c) => c.session.live).length;
  const elsewhere = sessions.filter((c) => runsElsewhere(c.session)).length;
  const n = sessions.length;
  const remove = (c: Closable) => removeSession(sessionKey(c.session), transcripts && !runs(c.session));
  return (
    <Confirm title={`Remove ${plural(n, "session")}?`} action={`Remove ${n}`} disabled={!n} onConfirm={() => settle(sessions, remove, "removed", setRefused)} onClose={onClose}>
      <p className="muted">
        Desk forgets each — its card, its Floor turns, its unread and its Activity — and won't pick it up again.
        {stopping ? ` ${stopping === n ? "They're" : `${stopping} of them ${stopping === 1 ? "is" : "are"}`} running in Desk, so they stop.` : ""}
        {elsewhere ? ` ${elsewhere === n ? "They keep" : `${elsewhere} of them ${elsewhere === 1 ? "keeps" : "keep"}`} running in their own terminals; Desk stops tracking them.` : ""} You
        can track them again from Settings → Sessions.
      </p>
      <ul className="close-list" aria-label="Sessions to remove">
        {sessions.map((c) => (
          <PickedRow key={c.key} c={c} why={removeWhy(c, refused[c.key])} />
        ))}
      </ul>
      <label className="confirm-check small">
        <input type="checkbox" checked={transcripts && running < n} disabled={running === n} onChange={(e) => setTranscripts(e.target.checked)} />
        <span>
          Also delete their transcripts
          {running === n ? " (not while they run)" : transcripts ? " — they can't be resumed after this" : ""}
        </span>
      </label>
    </Confirm>
  );
}
