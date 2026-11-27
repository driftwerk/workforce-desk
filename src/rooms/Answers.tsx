import { useState } from "react";
import { useDesk } from "../hub/store";
import { HubError } from "../hub/client";
import type { AnswerOption } from "../hub/types";
import { plainError } from "../ui/plainError";

// The answers to what a boss asks, pressed wherever it is asked: the chat's
// update and question, and a plan's card.

/** The answers, each with whether it is the one recommended: as the hub
 *  says, or the only one the recommendation's words name. */
export function answerOptions(
  options: readonly AnswerOption[],
  recommendation?: string | null,
  /** The hub laid them out (`needsYou`): it says of each, so no guess
   *  over its "none". */
  told = false,
): { label: string; recommended: boolean }[] {
  const said = options.map((o) => (typeof o === "string" ? { label: o, recommended: false } : { label: o.label, recommended: !!o.recommended }));
  if (told || said.some((o) => o.recommended)) return said;
  const labels = said.map((o) => o.label);
  const best = recommended(labels, recommendation) ?? closest(labels, recommendation);
  return said.map((o) => ({ ...o, recommended: o.label === best }));
}

const words = (s: string): string[] =>
  plain(s)
    .split(" ")
    .filter((w) => w.length > 2);

/** The option most of whose words the recommendation says, when it clearly
 *  leads every other: most of its words said, and a third more of them
 *  than the next. None when it's close: a wrong button lit is worse than
 *  none. */
export function closest(options: readonly string[], recommendation?: string | null): string | null {
  const said = new Set(words(recommendation ?? ""));
  if (!said.size) return null;
  const scored = options
    .map((o) => {
      const w = words(o);
      return { o, score: w.length ? w.filter((x) => said.has(x)).length / w.length : 0 };
    })
    .sort((a, b) => b.score - a.score);
  const [first, second] = scored;
  if (!first || first.score < 0.6) return null;
  return !second || first.score - second.score >= 0.34 ? first.o : null;
}

const plain = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The one of `options` the boss recommends: the one its recommendation
 *  is, or the only one its words name ("I'd rewrite saved copies, so …"
 *  names "Rewrite saved copies"); none when they name several or none. */
export function recommended(options: readonly string[], recommendation?: string | null): string | null {
  const r = recommendation ? plain(recommendation) : "";
  if (!r) return null;
  const exact = options.find((o) => plain(o) === r);
  if (exact) return exact;
  const named = options.filter((o) => {
    const p = plain(o);
    return p.length > 0 && ` ${r} `.includes(` ${p} `);
  });
  return named.length === 1 ? named[0]! : null;
}

// What you settled here, by decision and by item, for as long as Desk
// runs: a row drawn again (scrolled away and back) says so at once, as the
// hub would when asked again.
export const settledHere = new Map<string, string>();
const heldHere = new Set<string>();
/** Answers that offer "Always", by item: the answer given. */
const offerHere = new Map<string, string>();
/** What came of an "Always" or "Just this time", by item. */
const alwaysHere = new Map<string, string>();

/** The answers to what the boss asked: settled on the hub when pressed,
 *  the recommended one filled amber, the rest outlined, and Hold, which
 *  leaves it open for later. Drop on one set aside. */
export function Answers({
  id,
  label,
  options,
  recommendation,
  parked,
  generalizes,
  told,
}: {
  id: string;
  /** What it answers, for a screen reader: an update may hold several. */
  label: string;
  options: readonly AnswerOption[];
  recommendation?: string | null;
  parked?: boolean;
  /** The kind of case an answer would settle from then on: offered as
   *  "Always" once it's answered. */
  generalizes?: string | null;
  told?: boolean;
}) {
  const connected = useDesk((s) => !!s.hub);
  const [offer, setOfferHere] = useState<string | null>(offerHere.get(id) ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [held, setHeldHere] = useState(heldHere.has(id));
  const setHeld = (on: boolean) => {
    if (on) heldHere.add(id);
    else heldHere.delete(id);
    setHeldHere(on);
  };
  const [settled, setSettledHere] = useState<string | null>(settledHere.get(id) ?? null);
  const setSettled = (said: string) => {
    settledHere.set(id, said);
    setSettledHere(said);
  };
  const [problem, setProblem] = useState<string | null>(null);
  // Asked with nothing to press: answered in your own words.
  if (!options.length && !parked) return <p className="faint small">Answer in this chat.</p>;
  if (settled)
    return (
      <>
        <p className="faint small" role="status">
          {settled}
        </p>
        {offer && generalizes && <Always id={id} when={generalizes} then={offer} />}
      </>
    );
  if (held)
    return (
      <p className="faint small" role="status">
        Left open. Nothing was sent.{" "}
        <button type="button" className="link small" onClick={() => setHeld(false)}>
          Answer now
        </button>
      </p>
    );
  const act = async (what: string, run: () => Promise<unknown>, said: string, answer?: string) => {
    setBusy(what);
    setProblem(null);
    try {
      await run();
      if (answer && generalizes?.trim()) {
        offerHere.set(id, answer);
        setOfferHere(answer);
      }
      setSettled(said);
    } catch (e) {
      if (e instanceof HubError && (e.status === 404 || e.status === 409)) setSettled("Already settled.");
      else setProblem(plainError(e));
    }
    setBusy(null);
  };
  const hub = () => useDesk.getState().hub;
  const answers = answerOptions(options, recommendation, told);
  return (
    <>
      <div className="dm-inline" role="group" aria-label={`Your answer: ${label}`}>
        {answers.map((o) => (
          <button
            key={o.label}
            type="button"
            className={`btn btn-sm${o.recommended ? " btn-blocked" : ""}`}
            disabled={busy !== null || !connected}
            onClick={() => void act(o.label, () => hub()!.answerItem(id, o.label), `You answered: ${o.label}`, o.label)}
          >
            {o.label}
          </button>
        ))}
        {answers.length > 0 && (
          <button type="button" className="link needs-hold" disabled={busy !== null} onClick={() => setHeld(true)}>
            Hold, I'll look
          </button>
        )}
        {parked && (
          <button
            type="button"
            className="link small"
            aria-label={`Drop: ${label}`}
            disabled={busy !== null || !connected}
            onClick={() => void act("drop", () => hub()!.dropItem(id), "Dropped.")}
          >
            Drop
          </button>
        )}
      </div>
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

/** Its first letter small, unless it starts a word in capitals ("CI"). */
const lowerFirst = (s: string): string => (/^[A-Z](?![A-Z])/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** After an answer: "Always do this when …? Always · Just this time".
 *  Always keeps it as a preference, listed in the boss's settings. */
function Always({ id, when, then }: { id: string; when: string; then: string }) {
  const connected = useDesk((s) => !!s.hub);
  const [said, setSaidHere] = useState<string | null>(alwaysHere.get(id) ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const setSaid = (s: string) => {
    alwaysHere.set(id, s);
    setSaidHere(s);
  };
  const plainWhen = lowerFirst(when.trim().replace(/^(when(ever)?|if)\s+/i, "").replace(/[.?:,]+$/, ""));
  if (said) return <p className="faint small">{said}</p>;
  const always = async () => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    setBusy(true);
    setProblem(null);
    try {
      // The hub keeps it from the item (its boss, where it holds, the rule
      // in words) and says it back.
      const r = await hub.alwaysItem(id, then);
      setSaid(`${r.done} It’s in the boss’s settings, to change or forget.`);
    } catch (e) {
      // Dropped or gone since: nothing left to keep.
      if (e instanceof HubError && (e.status === 404 || e.status === 409)) setSaid("Already settled.");
      else setProblem(plainError(e));
    }
    setBusy(false);
  };
  return (
    <p className="small" role="group" aria-label="Always or just this time">
      <span className="muted">Always do this when {plainWhen}?</span>{" "}
      <button type="button" className="link dec-undo" disabled={busy || !connected} onClick={() => void always()}>
        Always
      </button>
      <span className="faint"> · </span>
      <button type="button" className="link" disabled={busy} onClick={() => setSaid("Just this time.")}>
        Just this time
      </button>
      {problem && (
        <span className="state-blocked" role="alert">
          {" "}
          {problem}
        </span>
      )}
    </p>
  );
}
