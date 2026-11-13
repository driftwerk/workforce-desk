import { useState } from "react";
import { useDesk } from "../hub/store";
import { HubError } from "../hub/client";
import type {
  AnswerOption,
  DecisionLine,
  DeskExtras,
  MentionedItem,
  MentionedUpdate,
  NeedItem,
  SessionState,
  UpdateSession,
  WaitingItem,
  WorkRef,
} from "../hub/types";
import type { DeliveryKind } from "../chat/types";
import { openLink } from "../shell/links";
import { plainError } from "../ui/plainError";

// What the boss says in your chat with it, laid out as the agreed "Update"
// board has it, in Desk's own tokens and never boxed:
//
// 1. What happened, first: one line per session with its state's dot, and
//    what it's for and what it names (PRs, tickets) small and faint under.
// 2. What needs you, set apart by one inset amber rule: a small-caps label
//    with how long it has waited, the question in one bold line, what it
//    is about as a short list, "I'd say:", the recommended answer as the
//    one filled button, the others outlined, and Hold as plain text.
// 3. What I did: one line per decision, its time in a mono column, what it
//    did in the text colour and why in muted grey, the message it sent
//    behind "Message", and Undo. The times it chose to do nothing fold into
//    one line.
//
// The hub is moving to saying each part apart (a decision's action, why
// and message; a question, its items and options). Until it does, each is
// read out of the words it sends now.

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
  if (extras.item) return <NeedsYouPost item={extras.item} content={content} />;
  if (extras.decisions?.length)
    return (
      <div className="msg-text overseer">
        <WhatIDid decisions={extras.decisions} labelled={false} />
      </div>
    );
  return null;
}

/** A session's question the boss gave you: set apart as what needs you,
 *  its ask in one bold line and the boss's why under it. Its answers
 *  follow, from its card. */
export function QuestionBody({ content }: { content: string }) {
  const [first = "", ...rest] = paragraphs(content);
  return (
    <div className="msg-text overseer">
      <section className="needs" aria-label="Needs you">
        <span className="sec-label">Needs you</span>
        <p className="needs-q">{first}</p>
        {rest.map((p, i) => (
          <p key={i} className="muted">
            {p}
          </p>
        ))}
      </section>
    </div>
  );
}

// ── Reading the parts out of the words ─────────────────────────────────────

const paragraphs = (text: string): string[] =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

/** `text`'s first sentence, and the rest. */
export function firstSentence(text: string): [string, string] {
  const t = text.trim();
  const m = t.match(/^([\s\S]+?[.?!])(?:\s+|$)([\s\S]*)$/);
  return m ? [m[1]!.trim(), m[2]!.trim()] : [t, ""];
}

/** Markdown's bold and the lead the hub puts first, gone. */
const unlead = (text: string): string =>
  text
    .trim()
    .replace(/^\*\*(Needs you\.|Still waiting on you:)\*\*\s*/, "")
    .replace(/^(Needs you\.|Still waiting on you:)\s*/, "")
    .replace(/\*\*/g, "");

const LIST = /^\s*(?:[-*•]|\d+[.)]|\(\d+\))\s+(.+)$/;

/** A question as the hub words it today: its first sentence the question,
 *  its listed lines (`- …`, `1. …`, `(1) …`) the items, and anything else
 *  said after. */
export function readNeed(text: string): { question: string; items: string[]; rest: string } {
  const lines = unlead(text).split("\n");
  const items: string[] = [];
  const prose: string[] = [];
  for (const l of lines) {
    const m = l.match(LIST);
    if (m) items.push(m[1]!.trim());
    else if (l.trim()) prose.push(l.trim());
  }
  const [question, rest] = firstSentence(prose.join(" "));
  return { question, items, rest };
}

/** A needs-you or still-waiting message, read: the hub's text, then what
 *  it holds up, the boss's recommendation, its notes, and (still waiting)
 *  how long it has waited. The prefixes are the hub's own words
 *  (`crates/hub/src/desk_crew/items.rs` `needs_you` and the restatements;
 *  `open_item.rs` `still_waiting`). */
export function readNeedsPost(content: string): {
  text: string;
  age: string | null;
  holdingUp: string | null;
  recommendation: string | null;
  notes: string[];
} {
  const [first = "", ...rest] = paragraphs(content);
  let text = unlead(first);
  let age: string | null = null;
  let holdingUp: string | null = null;
  // "Still waiting on you: {text} · {age} · {holding up}"
  if (/^(\*\*)?Still waiting on you:/.test(first.trim())) {
    const parts = text.split(" · ");
    if (parts.length > 1 && /^(just now|\d+ (min|h|days))$/.test(parts[1]!.trim())) {
      text = parts[0]!;
      age = parts[1]!.trim();
      holdingUp = parts.slice(2).join(" · ").trim() || null;
    }
  }
  let recommendation: string | null = null;
  const notes: string[] = [];
  for (const p of rest) {
    const held = p.match(/^Holding up:\s*([\s\S]+)$/);
    const said = p.match(/^I'd say:\s*([\s\S]+)$/);
    if (held) holdingUp = held[1]!.trim();
    else if (said) recommendation = said[1]!.trim();
    else notes.push(p);
  }
  return { text, age, holdingUp, recommendation, notes };
}

const sentence = (s: string): string => {
  const t = s.trim();
  if (!t) return t;
  const up = t[0]!.toUpperCase() + t.slice(1);
  return /[.?!…”"]$/.test(up) ? up : `${up}.`;
};

/** A quoted message long enough to be the one sent ("told it: “…”"). */
const QUOTED = /\s*[:—–-]?\s*[“"]([^”"]{60,})[”"]\s*\.?/;

const NOTHING = /^(let\b.*\bwait|left\b.*\balone|sent nothing|did nothing|held off|waited)\b/i;

/** A decision's parts: what it did, why, the message it sent, and whether
 *  it chose to do nothing. The hub's own fields when it gives them; read
 *  out of its line when it doesn't. */
export function decisionParts(line: DecisionLine): { action: string; why: string; message: string | null; leftAlone: boolean } {
  const text = line.text.trim();
  const quoted = line.message === undefined ? text.match(QUOTED) : null;
  const message = line.message ?? (quoted ? quoted[1]!.trim() : null);
  const stripped = quoted ? text.replace(QUOTED, " ").replace(/\s+/g, " ").trim() : text;
  const action = (line.action ?? "").trim() || stripped || text;
  const leftAlone = line.kind ? line.kind === "left_alone" : NOTHING.test(action);
  return { action: sentence(action), why: sentence(line.why ?? ""), message, leftAlone };
}

/** The answers, each with whether it is the one recommended: as the hub
 *  says, or the only one the recommendation's words name. */
export function answerOptions(options: readonly AnswerOption[], recommendation?: string | null): { label: string; recommended: boolean }[] {
  const said = options.map((o) => (typeof o === "string" ? { label: o, recommended: false } : { label: o.label, recommended: !!o.recommended }));
  if (said.some((o) => o.recommended)) return said;
  const best = recommended(
    said.map((o) => o.label),
    recommendation,
  );
  return said.map((o) => ({ ...o, recommended: o.label === best }));
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

const clock = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

// ── 1. What happened ──────────────────────────────────────────────────────

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

/** A session's state as its dot shows it. */
const LOOK: Partial<Record<SessionState, string>> = {
  starting: "working",
  working: "working",
  blocked: "blocked",
  asking: "blocked",
  interrupted: "blocked",
  done: "done",
};

function SessionLine({ s }: { s: UpdateSession }) {
  // Its own state alone: another session's event doesn't draw it again.
  const state = useDesk((d) => d.sessions[s.sessionId]?.state);
  const look = (state && LOOK[state]) || "idle";
  const [head, rest] = firstSentence(s.text);
  const purpose = s.purpose?.trim().replace(/\.$/, "");
  const refs = s.refs ?? [];
  return (
    <div className="upd-session">
      <p className="upd-line">
        <span className={`dot dot-${look}`} aria-hidden="true" />
        <strong>{s.name}</strong> {head}
      </p>
      {rest && <p className="upd-rest muted">{rest}</p>}
      {(purpose || refs.length > 0) && (
        <p className="upd-sub faint">
          {purpose}
          {purpose && refs.length > 0 && " · "}
          {refs.map((r, i) => (
            <span key={`${r.kind}:${r.id}`}>
              {i > 0 && <span className="ref"> · </span>}
              <Ref r={r} />
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function Update({ update }: { update: MentionedUpdate }) {
  const sessions = update.sessions ?? [];
  const kept = update.kept ?? [];
  return (
    <div className="msg-text overseer">
      {(sessions.length > 0 || kept.length > 0) && (
        <div className="upd-head">
          {sessions.map((s) => (
            <SessionLine key={s.sessionId} s={s} />
          ))}
          {kept.map((k, i) => (
            <p key={`kept-${i}`} className="upd-kept">
              {k}
            </p>
          ))}
        </div>
      )}
      {(update.waiting ?? []).map((w) => (
        <Waiting key={w.itemId} w={w} />
      ))}
      {(update.decisions ?? []).length > 0 && <WhatIDid decisions={update.decisions!} />}
      {update.footer && <p className="faint small">{update.footer}</p>}
    </div>
  );
}

// ── 2. What needs you ─────────────────────────────────────────────────────

function Items({ items }: { items: readonly NeedItem[] }) {
  if (!items.length) return null;
  return (
    <ol className="needs-items">
      {items.map((it, i) => {
        const [lead, rest] = typeof it === "string" ? firstSentence(it) : [it.text, it.detail ?? ""];
        return (
          <li key={i}>
            <span className="needs-lead">{lead}</span>
            {rest ? ` ${rest}` : null}
          </li>
        );
      })}
    </ol>
  );
}

function Needs({
  id,
  age,
  question,
  items,
  rest,
  recommendation,
  options,
  parked,
  notes,
}: {
  id: string;
  age?: string | null;
  question: string;
  items: readonly NeedItem[];
  rest?: string;
  recommendation?: string | null;
  options: readonly AnswerOption[];
  parked?: boolean;
  /** Faint lines last: what isn't held up, what it holds up, the boss's
   *  notes. */
  notes: readonly (string | null | undefined)[];
}) {
  return (
    <section className="needs" aria-label="Needs you">
      <span className="sec-label">
        Needs you{age ? (age === "just now" ? " · just now" : ` · waiting ${age}`) : ""}
      </span>
      <p className="needs-q">{question}</p>
      <Items items={items} />
      {rest && <p className="muted">{rest}</p>}
      {recommendation && (
        <p className="muted">
          <span className="needs-rec">I'd say:</span> {recommendation}
        </p>
      )}
      <Answers id={id} label={question} options={options} recommendation={recommendation} parked={parked} />
      {notes
        .filter((n): n is string => !!n?.trim())
        .map((n, i) => (
          <p key={i} className="faint small">
            {n}
          </p>
        ))}
    </section>
  );
}

/** Something still waiting on you, as an update lists it. */
function Waiting({ w }: { w: WaitingItem }) {
  const read = readNeed(w.text);
  return (
    <Needs
      id={w.itemId}
      age={w.age}
      question={w.question?.trim() || read.question}
      items={w.items ?? read.items}
      rest={w.question ? undefined : read.rest}
      recommendation={w.recommendation}
      options={w.options ?? []}
      notes={[w.notBlocking, w.holdingUp]}
    />
  );
}

/** A needs-you or still-waiting message of its own. */
function NeedsYouPost({ item, content }: { item: MentionedItem; content: string }) {
  const post = readNeedsPost(content);
  const read = readNeed(post.text);
  return (
    <div className="msg-text overseer">
      <Needs
        id={item.itemId}
        age={post.age}
        question={item.question?.trim() || read.question}
        items={item.items ?? read.items}
        rest={item.question ? undefined : read.rest}
        recommendation={item.recommendation || post.recommendation}
        options={item.options ?? []}
        parked={item.parked}
        notes={[item.notBlocking, post.holdingUp, ...post.notes]}
      />
    </div>
  );
}

// What you settled here, by decision and by item, for as long as Desk
// runs: a row drawn again (scrolled away and back) says so at once, as the
// hub would when asked again.
const undoneHere = new Map<string, string>();
const settledHere = new Map<string, string>();

/** The answers to what the boss asked: settled on the hub when pressed,
 *  the recommended one filled amber, the rest outlined, and Hold, which
 *  leaves it open for later. Drop on one set aside. */
function Answers({
  id,
  label,
  options,
  recommendation,
  parked,
}: {
  id: string;
  /** What it answers, for a screen reader: an update may hold several. */
  label: string;
  options: readonly AnswerOption[];
  recommendation?: string | null;
  parked?: boolean;
}) {
  const connected = useDesk((s) => !!s.hub);
  const [busy, setBusy] = useState<string | null>(null);
  const [held, setHeld] = useState(false);
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
  if (held)
    return (
      <p className="faint small" role="status">
        Held: it stays open until you answer.{" "}
        <button type="button" className="link small" onClick={() => setHeld(false)}>
          Answer now
        </button>
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
  const answers = answerOptions(options, recommendation);
  return (
    <>
      <div className="dm-inline" role="group" aria-label={`Your answer: ${label}`}>
        {answers.map((o) => (
          <button
            key={o.label}
            type="button"
            className={`btn btn-sm${o.recommended ? " btn-blocked" : ""}`}
            disabled={busy !== null || !connected}
            onClick={() => void act(o.label, () => hub()!.answerItem(id, o.label), `You answered: ${o.label}`)}
          >
            {o.label}
          </button>
        ))}
        {answers.length > 0 && (
          <button type="button" className="link small needs-hold" disabled={busy !== null} onClick={() => setHeld(true)}>
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

// ── 3. What I did ─────────────────────────────────────────────────────────

export const UNDO_LABEL: Record<NonNullable<DecisionLine["undo"]>, string> = {
  undo: "Undo",
  correct: "Correct",
  stop: "Stop it",
  resume: "Resume",
};

/** The boss's decisions, one line each; the times it did nothing folded
 *  into one line that opens on a click. `labelled`: under "What I did",
 *  as an update says them. */
function WhatIDid({ decisions, labelled = true }: { decisions: readonly DecisionLine[]; labelled?: boolean }) {
  const [open, setOpen] = useState(false);
  const parts = decisions.map((d) => ({ line: d, ...decisionParts(d) }));
  const acted = parts.filter((p) => !p.leftAlone);
  const alone = parts.filter((p) => p.leftAlone);
  const timed = decisions.some((d) => !!clock(d.at));
  const since = alone[0]?.why ? `, since ${alone[0].why[0]!.toLowerCase()}${alone[0].why.slice(1).replace(/\.$/, "")}` : "";
  return (
    <section className="did" aria-label="What I did">
      {labelled && <span className="sec-label">What I did</span>}
      <ul className={`did-list${timed ? "" : " untimed"}`}>
        {acted.map((p) => (
          <DecisionRow key={p.line.id} {...p} timed={timed} />
        ))}
        {alone.length > 0 && (
          <li className="dec-row">
            {timed && <span className="dec-time" />}
            <button type="button" className="link dec-fold" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "− " : "+ "}
              {alone.length} {alone.length === 1 ? "time" : "times"} I left it alone{open ? "" : since}
            </button>
          </li>
        )}
        {open && alone.map((p) => <DecisionRow key={p.line.id} {...p} timed={timed} />)}
      </ul>
    </section>
  );
}

function DecisionRow({ line, action, why, message, timed }: { line: DecisionLine; action: string; why: string; message: string | null; timed: boolean }) {
  const connected = useDesk((s) => !!s.hub);
  const [undone, setUndone] = useState<string | null>(undoneHere.get(line.id) ?? null);
  // A decision that can't be undone after all: no button to press again.
  const [fixed, setFixed] = useState(false);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const done = (said: string) => {
    undoneHere.set(line.id, said);
    setUndone(said);
  };
  // Undone here, or elsewhere as the message now says.
  const isUndone = undone !== null || !!line.undone;
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
  const what = action.replace(/\.$/, "");
  return (
    <li className="dec-row">
      {timed && <span className="dec-time">{clock(line.at)}</span>}
      <span className="dec-text">
        <span className={`dec-action${isUndone ? " dec-undone" : ""}`}>{action}</span>
        {why && <span className="muted"> {why}</span>}
        {isUndone && (
          <span className="faint small" role="status">
            {" "}
            {undone ? `Undone: ${undone}.` : "Undone."}
          </span>
        )}
        {problem && (
          <span className="small state-blocked" role="alert">
            {" "}
            {problem}
          </span>
        )}
      </span>
      <span className="dec-tools">
        {message && (
          <button type="button" className="link dec-msg" aria-expanded={shown} aria-label={`The message: ${what}`} onClick={() => setShown((s) => !s)}>
            Message
          </button>
        )}
        {!isUndone && line.undo && !fixed && (
          <button
            type="button"
            className="link dec-undo"
            aria-label={`${UNDO_LABEL[line.undo]}: ${what}`}
            disabled={busy || !connected}
            onClick={() => void undo()}
          >
            {UNDO_LABEL[line.undo]}
          </button>
        )}
      </span>
      {shown && message && <p className="dec-message">{message}</p>}
    </li>
  );
}
