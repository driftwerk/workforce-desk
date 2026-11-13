import { RichMarkdown } from "@workforce/rich";
import { useState } from "react";
import { useDesk } from "../hub/store";
import { HubError } from "../hub/client";
import type { DecisionLine, DeskExtras, MentionedItem, MentionedUpdate, WaitingItem, WorkRef } from "../hub/types";
import type { DeliveryKind } from "../chat/types";
import { openLink } from "../shell/links";
import { plainError } from "../ui/plainError";

// What the boss says in your chat with it, the way the agreed look has it:
// plain text in Desk's own tokens, never a box. An update names each
// session in semibold with what it's for in faint, then where it is; "I
// decided:" lines are muted, with Undo as a small link; what needs you
// leads in the blocked colour, its recommendation muted, and its answers
// as a row of buttons, the recommended one in the signal colour.

/** Whether the boss's message is shown from its extras in place of its
 *  markdown: an update, something it asks of you, or a decision of its
 *  own. */
export const overseerShown = (extras: DeskExtras | undefined): boolean =>
  !!extras && (!!extras.update || !!extras.item || !!extras.decisions?.length);

/** Whether the boss's message is one of what the chat shows unboxed: an
 *  update, a decision, or something it asks of you (its own, or a
 *  session's question it gave you). Its cards go inline. */
export const overseerPost = (extras: DeskExtras | undefined, delivery: DeliveryKind | undefined): boolean =>
  overseerShown(extras) || delivery === "update" || delivery === "question";

/** What the boss's message shows in place of its markdown, from its
 *  extras; `content` stands in for anything they don't say. */
export function OverseerBody({ extras, content }: { extras: DeskExtras; content: string }) {
  if (extras.update) return <Update update={extras.update} />;
  if (extras.item) return <NeedsYou item={extras.item} content={content} />;
  if (extras.decisions?.length)
    return (
      <div className="msg-text overseer">
        {extras.decisions.map((d) => (
          <Decision key={d.id} line={d} />
        ))}
      </div>
    );
  return null;
}

/** A session's question the boss gave you, said as needs-you: its lead
 *  in the blocked colour, then the boss's words. */
export function QuestionBody({ content }: { content: string }) {
  return (
    <div className="msg-text overseer needs-you">
      <Paragraphs text={led(content)} />
    </div>
  );
}

/** `text` led by "Needs you." unless it already leads with that, or with
 *  "Still waiting on you:", bold either way. */
export function led(text: string): string {
  const t = text.trim();
  if (/^\*\*(Needs you\.|Still waiting on you:)\*\*/.test(t)) return t;
  const waiting = t.match(/^Still waiting on you:\s*/);
  if (waiting) return `**Still waiting on you:** ${t.slice(waiting[0].length)}`;
  const needs = t.match(/^Needs you\.\s*/);
  return `**Needs you.** ${needs ? t.slice(needs[0].length) : t}`;
}

/** The boss's paragraphs as markdown, its recommendation muted and its
 *  notes (what it holds up, what more is open) faint. The prefixes are the
 *  hub's own words (`crates/hub/src/desk_crew/items.rs`, `needs_you` and
 *  the restatements; `open_item.rs` `still_waiting`): changed there, only
 *  their shade here goes. */
function Paragraphs({ text }: { text: string }) {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <>
      {paras.map((p, i) => (
        <div
          key={i}
          className={`rich${i > 0 && /^I'd say:/.test(p) ? " muted" : i > 0 && /^(Holding up:|I won't bring|And \d+ more)/.test(p) ? " faint" : ""}`}
        >
          <RichMarkdown text={p} />
        </div>
      ))}
    </>
  );
}

function Ref({ r }: { r: WorkRef }) {
  if (!r.url || !/^https?:\/\//i.test(r.url)) return <span className="ref">{r.id}</span>;
  const url = r.url;
  return (
    <a
      className="ref"
      href={url}
      onClick={(e) => {
        e.preventDefault();
        openLink(url);
      }}
    >
      {r.id}
    </a>
  );
}

function Update({ update }: { update: MentionedUpdate }) {
  return (
    <div className="msg-text overseer">
      {(update.sessions ?? []).map((s) => (
        <p key={s.sessionId}>
          <strong>{s.name}</strong>
          {s.purpose?.trim() ? <span className="faint"> ({s.purpose.trim().replace(/\.$/, "")})</span> : null} {s.text}
          {(s.refs ?? []).map((r) => (
            <span key={`${r.kind}:${r.id}`}>
              {" "}
              <Ref r={r} />
            </span>
          ))}
        </p>
      ))}
      {(update.decisions ?? []).map((d) => (
        <Decision key={d.id} line={d} />
      ))}
      {(update.kept ?? []).map((k, i) => (
        <p key={`kept-${i}`}>{k}</p>
      ))}
      <Waiting items={update.waiting ?? []} />
      {update.footer && <p className="faint small">{update.footer}</p>}
    </div>
  );
}

/** "I decided: what — why", with its Undo. */
function Decision({ line }: { line: DecisionLine }) {
  return (
    <p className="muted">
      <span className="dec-label">I decided:</span> <DecisionText line={line} />
    </p>
  );
}

// What you settled here, by decision and by item, for as long as Desk
// runs: a row drawn again (scrolled away and back) says so at once, as the
// hub would when asked again.
const undoneHere = new Map<string, string>();
const settledHere = new Map<string, string>();

export const UNDO_LABEL: Record<NonNullable<DecisionLine["undo"]>, string> = {
  undo: "Undo",
  correct: "Correct",
  stop: "Stop it",
  resume: "Resume",
};

function DecisionText({ line }: { line: DecisionLine }) {
  const connected = useDesk((s) => !!s.hub);
  const [undone, setUndone] = useState<string | null>(undoneHere.get(line.id) ?? null);
  // A decision that can't be undone after all: no button to press again.
  const [fixed, setFixed] = useState(false);
  const done = (said: string) => {
    undoneHere.set(line.id, said);
    setUndone(said);
  };
  // Undone here, or elsewhere as the message now says.
  const isUndone = undone !== null || !!line.undone;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const what = line.text.trim().replace(/\.$/, "");
  const said = line.why?.trim() ? `${what} — ${line.why.trim()}` : `${what}.`;
  const undo = async () => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await hub.undoDecision(line.id);
      done(r?.done ?? "");
    } catch (e) {
      // Undone already elsewhere, or gone with its session: it shows so.
      if (e instanceof HubError && (e.status === 409 || e.status === 404)) done("");
      else {
        if (e instanceof HubError && e.status === 400) setFixed(true);
        setProblem(plainError(e));
      }
    }
    setBusy(false);
  };
  return (
    <>
      <span className={isUndone ? "dec-undone" : undefined}>{said}</span>
      {isUndone ? (
        <span className="faint small" role="status">
          {" "}
          {undone ? `Undone: ${undone}.` : "undone"}
        </span>
      ) : (
        line.undo &&
        !fixed && (
          <>
            {" "}
            <button
              type="button"
              className="link small dec-undo"
              aria-label={`${UNDO_LABEL[line.undo]}: ${what}`}
              disabled={busy || !connected}
              onClick={() => void undo()}
            >
              {UNDO_LABEL[line.undo]}
            </button>
          </>
        )
      )}
      {problem && (
        <span className="small state-blocked" role="alert">
          {" "}
          {problem}
        </span>
      )}
    </>
  );
}

/** "Still waiting on you:" and each item in full, with its answers. */
function Waiting({ items }: { items: WaitingItem[] }) {
  if (!items.length) return null;
  return (
    <>
      {items.map((w, i) => (
        <div key={w.itemId} className="dm-waiting">
          <p>
            {i === 0 && <span className="state-blocked strong">Still waiting on you:</span>} {w.text}
            {w.age ? <span className="faint"> · {w.age}</span> : null}
            {w.holdingUp ? <span className="faint"> · {w.holdingUp}</span> : null}
          </p>
          {w.recommendation && <p className="muted">I'd say: {w.recommendation}</p>}
          <Answers id={w.itemId} label={w.text} options={w.options ?? []} recommendation={w.recommendation} />
        </div>
      ))}
    </>
  );
}

/** A needs-you or still-waiting message: its lead in the blocked colour,
 *  its words as the boss wrote them (markdown and all), the
 *  recommendation muted, and its answers. */
function NeedsYou({ item, content }: { item: MentionedItem; content: string }) {
  return (
    <div className="msg-text overseer needs-you">
      <Paragraphs text={led(content)} />
      <Answers id={item.itemId} options={item.options ?? []} recommendation={item.recommendation} parked={item.parked} />
    </div>
  );
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

/** The answers to what the boss asked: settled on the hub when pressed.
 *  Nothing to press when it asked nothing with answers; Drop on one set
 *  aside. */
function Answers({
  id,
  label,
  options,
  recommendation,
  parked,
}: {
  id: string;
  /** What it answers, for a screen reader: an update may hold several. */
  label?: string;
  options: string[];
  recommendation?: string | null;
  parked?: boolean;
}) {
  const connected = useDesk((s) => !!s.hub);
  const [busy, setBusy] = useState<string | null>(null);
  const [settled, setSettledHere] = useState<string | null>(settledHere.get(id) ?? null);
  const setSettled = (said: string) => {
    settledHere.set(id, said);
    setSettledHere(said);
  };
  const [problem, setProblem] = useState<string | null>(null);
  if (!options.length && !parked) return null;
  if (settled)
    return (
      <p className="faint small" role="status">
        {settled}
      </p>
    );
  const act = async (what: string, run: () => Promise<unknown>, said: string) => {
    setBusy(what);
    setProblem(null);
    try {
      await run();
      setSettled(said);
    } catch (e) {
      if (e instanceof HubError && (e.status === 404 || e.status === 409)) setSettled("Already settled.");
      else setProblem(plainError(e));
    }
    setBusy(null);
  };
  const hub = () => useDesk.getState().hub;
  const best = recommended(options, recommendation);
  return (
    <>
      <div className="dm-inline" role="group" aria-label={label ? `Your answer: ${label}` : "Your answer"}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            className={`btn btn-sm${o === best ? " btn-signal" : ""}`}
            disabled={busy !== null || !connected}
            onClick={() => void act(o, () => hub()!.answerItem(id, o), `You answered: ${o}`)}
          >
            {o}
          </button>
        ))}
        {parked && (
          <button
            type="button"
            className="link small"
            aria-label={label ? `Drop: ${label}` : "Drop it"}
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
