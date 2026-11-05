import { useEffect, useRef, useState } from "react";
import { useDesk } from "../hub/store";
import type { ChargeView, Session } from "../hub/types";
import { useOverview } from "../overview/store";
import { plainError } from "../ui/plainError";
import { badgeOf, called, chargeChoices, howText, wheelText, type ChargeChoice } from "./charge";
import { useBossOf, useCharge, useCharges } from "./chargeStore";
import { sessionKey } from "../hub/machines";

/** The badge on a session a boss runs: "Sarah has it" (or "Sarah's",
 *  `short`), dashed "You're driving" while the person has the wheel. */
export function ChargeBadge({ charge, short = false, className = "" }: { charge: ChargeView | undefined; short?: boolean; className?: string }) {
  const badge = badgeOf(charge, short);
  if (!charge || !badge) return null;
  return (
    <span className={`charge-badge charge-${badge.look} ${className}`} title={`${howText(charge)}. ${wheelText(charge)}`}>
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

/** A session card's word on who runs it: while a boss does, its badge,
 *  what that means, I'll drive or Hand back, and Release; then what the
 *  boss suggests for it while you drive. One the boss could run, Hand to
 *  it, quietly. */
export function ChargeStrip({ session }: { session: Session }) {
  const charge = useCharge(sessionKey(session));
  const boss = useBossOf(session);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const choices = chargeChoices(session, charge, boss);
  if (!charge && !choices.length) return null;
  const run = (c: ChargeChoice) => {
    if (busy) return;
    setBusy(c.verb);
    setProblem(null);
    useCharges
      .getState()
      .act(sessionKey(session), c.verb)
      .catch((e: unknown) => setProblem(plainError(e)))
      .finally(() => setBusy(null));
  };
  const name = session.displayName ?? session.name;
  const buttons = (
    <span className="charge-strip-buttons">
      {choices.map((c) => (
        <button key={c.verb} type="button" className={c.verb === "release" ? "btn btn-sm btn-ghost" : "btn btn-sm"} disabled={!!busy} onClick={() => run(c)}>
          {busy === c.verb ? `${c.label}…` : c.label}
        </button>
      ))}
    </span>
  );
  if (!charge)
    return (
      <div className="charge-strip charge-strip-quiet" role="group" aria-label={`Who runs ${name}`}>
        <span className="charge-strip-text">
          <span className="small faint">{called(boss?.name ?? "", true)} can run this session with you: it hears when each turn ends and tells it the next step.</span>
          {problem && (
            <span className="small state-blocked" role="alert">
              {problem}
            </span>
          )}
        </span>
        {buttons}
      </div>
    );
  return (
    <div className="charge-strip" role="status" aria-label={`Who runs ${name}`}>
      <span className="charge-strip-text">
        <ChargeBadge charge={charge} />
        <span className="small muted">{wheelText(charge)}</span>
        {problem && (
          <span className="small state-blocked" role="alert">
            {problem}
          </span>
        )}
      </span>
      {buttons}
      {charge.wheel !== "boss" && <BossSuggestions sessionId={session.id} bossName={charge.bossName} />}
    </div>
  );
}

/** While the person drives, what the boss would have done on this session
 *  comes as suggestions: each here, to do or dismiss. (The boss makes them
 *  once it answers for the sessions it runs.) */
function BossSuggestions({ sessionId, bossName }: { sessionId: string; bossName: string }) {
  const want = useOverview((s) => s.wantSuggestions);
  const suggestions = useOverview((s) => s.suggestions);
  useEffect(() => want(), [want]);
  const mine = Object.values(suggestions).filter((s) => s.state === "open" && s.subject?.kind === "session" && s.subject.id === sessionId);
  if (!mine.length) return null;
  return (
    <ul className="charge-suggestions" aria-label={`What ${called(bossName)} suggests`}>
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
