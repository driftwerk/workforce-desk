import { useEffect, useRef, useState } from "react";
import { useDesk } from "../hub/store";
import type { ChargeView, Session } from "../hub/types";
import { useOverview } from "../overview/store";
import { plainError } from "../ui/plainError";
import { badgeOf, called, chargeChoices, driving, howText, wheelText, type ChargeChoice } from "./charge";
import { useBossOf, useCharge, useCharges } from "./chargeStore";
import { Popover } from "../ui/Popover";
import { sessionKey } from "../hub/machines";

/** Why what the session `charge` is for waits on the person though its
 *  boss runs it, as the hub says; nothing while the boss has it. */
const useWaitsOnYou = (charge: ChargeView | undefined): string | undefined =>
  useDesk((s) => (charge ? s.sessions[charge.session]?.waitsOnYou : undefined));

/** What the badge's title says: why it waits on you, when it does, then
 *  how the boss came to run it and who has the wheel. */
const titleOf = (charge: ChargeView, waits: string | undefined): string => `${waits && !driving(charge) ? `Waiting on you: ${waits} ` : ""}${howText(charge)}. ${wheelText(charge)}`;

/** The badge on a session a boss runs: "Sarah has it" (or "Sarah's",
 *  `short`), dashed "You're driving" while the person has the wheel, and
 *  "Waiting on you" while what it waits on is the person's to answer. */
export function ChargeBadge({ charge, short = false, className = "" }: { charge: ChargeView | undefined; short?: boolean; className?: string }) {
  const waits = useWaitsOnYou(charge);
  const badge = badgeOf(charge, short, waits);
  if (!charge || !badge) return null;
  return (
    <span className={`charge-badge charge-${badge.look} ${className}`} title={titleOf(charge, waits)}>
      {badge.text}
    </span>
  );
}

/** What the person can do about who runs `session`, each ready to run: for
 *  menus and the pane's header (their problem goes to Desk's error line).
 *  One at a time: `busy` while one is on its way, and the others wait. */
export const useChargeActions = (session: Session | null | undefined): (ChargeChoice & { run: () => void; busy: boolean })[] => {
  const charge = useCharge(session && sessionKey(session));
  const boss = useBossOf(session);
  const [busy, setBusy] = useState(false);
  const going = useRef(false);
  if (!session) return [];
  return chargeChoices(session, charge, boss).map((c) => ({
    ...c,
    busy,
    run: () => {
      if (going.current) return;
      going.current = true;
      setBusy(true);
      useCharges
        .getState()
        .act(sessionKey(session), c.verb)
        .catch(useDesk.getState().fail)
        .finally(() => {
          going.current = false;
          setBusy(false);
        });
    },
  }));
};

/** Who runs `session`, in its chrome: the badge as a button ("Desk has it
 *  ▾", dashed "You're driving ▾"), with a count of what the boss suggests
 *  while you drive. It opens what that means and the choices: I'll drive,
 *  Hand back, Release. Nothing while no boss runs it (Hand to … is in the
 *  session's menu). */
export function DriverChip({ session }: { session: Session }) {
  const charge = useCharge(sessionKey(session));
  const boss = useBossOf(session);
  const suggested = useSuggested(charge && charge.wheel !== "boss" ? session.id : null).length;
  const [from, setFrom] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const going = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const waits = session.waitsOnYou;
  const badge = badgeOf(charge, false, waits);
  const short = badgeOf(charge, true, waits);
  if (!charge || !badge || !short) return null;
  const choices = chargeChoices(session, charge, boss);
  const run = (c: ChargeChoice) => {
    // Asked once, however quickly it's clicked again.
    if (going.current) return;
    going.current = true;
    setBusy(c.verb);
    setProblem(null);
    useCharges
      .getState()
      .act(sessionKey(session), c.verb)
      .then(() => setFrom(null))
      .catch((e: unknown) => setProblem(plainError(e)))
      .finally(() => {
        going.current = false;
        setBusy(null);
      });
  };
  const name = session.displayName ?? session.name;
  return (
    <>
      <button
        type="button"
        className={`charge-badge charge-${badge.look} sc-driver`}
        aria-haspopup="dialog"
        aria-expanded={!!from}
        aria-label={`Who runs it: ${badge.text}${suggested ? `, ${suggested} suggested` : ""}`}
        title={titleOf(charge, waits)}
        onClick={(e) => setFrom(from ? null : e.currentTarget)}
      >
        <span className="sc-long">{badge.text}</span>
        <span className="sc-short">{short.text}</span>
        {suggested > 0 && <span className="sc-count">{suggested}</span>}
        <Caret />
      </button>
      {from && (
        <Popover label={`Who runs ${name}`} from={from} onClose={() => setFrom(null)} className="driver-pop">
          <span className="driver-pop-head">
            <ChargeBadge charge={charge} />
            <span className="small faint">{howText(charge)}</span>
          </span>
          {waits && !driving(charge) && <p className="driver-pop-text">Waiting on you: {waits}</p>}
          <p className="driver-pop-text">{wheelText(charge)}</p>
          {problem && (
            <p className="small state-blocked" role="alert">
              {problem}
            </p>
          )}
          <span className="charge-strip-buttons">
            {choices.map((c) => (
              <button key={c.verb} type="button" className={c.verb === "release" ? "btn btn-sm btn-ghost" : "btn btn-sm"} disabled={!!busy} onClick={() => run(c)}>
                {busy === c.verb ? `${c.label}…` : c.label}
              </button>
            ))}
          </span>
        </Popover>
      )}
    </>
  );
}

/** What the boss suggests for this session while you drive: a bar of its
 *  own over the session, each to do or dismiss, since it waits on you. */
export function DriverBar({ session }: { session: Session }) {
  const charge = useCharge(sessionKey(session));
  if (!charge || charge.wheel === "boss") return null;
  return <BossSuggestions sessionId={session.id} bossName={charge.bossName} />;
}

const Caret = () => (
  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
    <path d="M1.5 3l2.5 2.5L6.5 3" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

/** The open suggestions for session `id` (none for null), read once asked. */
const useSuggested = (id: string | null) => {
  const want = useOverview((s) => s.wantSuggestions);
  const suggestions = useOverview((s) => s.suggestions);
  useEffect(() => {
    if (id) want();
  }, [id, want]);
  return id ? Object.values(suggestions).filter((s) => s.state === "open" && s.subject?.kind === "session" && s.subject.id === id) : [];
};

/** While the person drives, what the boss would have done on this session
 *  comes as suggestions: each here, to do or dismiss. (The boss makes them
 *  once it answers for the sessions it runs.) */
function BossSuggestions({ sessionId, bossName }: { sessionId: string; bossName: string }) {
  const mine = useSuggested(sessionId);
  if (!mine.length) return null;
  return (
    <ul className="charge-suggestions decide-bar" aria-label={`What ${called(bossName)} suggests`}>
      {mine.map((s) => (
        <BossSuggestion key={s.id} id={s.id} text={s.text} bossName={bossName} />
      ))}
    </ul>
  );
}

function BossSuggestion({ id, text, bossName }: { id: string; text: string; bossName: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const act = (what: "accept" | "dismiss") => {
    setBusy(true);
    setProblem(null);
    const s = useOverview.getState();
    (what === "accept" ? s.accept(id) : s.dismiss(id)).catch((e: unknown) => setProblem(plainError(e))).finally(() => setBusy(false));
  };
  return (
    <li className="charge-suggestion">
      <span className="small">
        <b>{called(bossName, true)} suggests</b> {text}
      </span>
      <span className="charge-strip-buttons">
        <button type="button" className="btn btn-sm btn-signal" disabled={busy} onClick={() => act("accept")}>
          Do it
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act("dismiss")}>
          Dismiss
        </button>
      </span>
      {problem && <span className="small state-blocked">{problem}</span>}
    </li>
  );
}
