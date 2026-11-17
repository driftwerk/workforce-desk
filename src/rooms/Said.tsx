import { useId, useState } from "react";
import type { BriefItem, Roundup, RoundupSection, Said, SessionLink } from "../hub/types";
import { openSession } from "../overview/people";
import { Row } from "./Brief";
import { UNDO_LABEL, useUndo } from "./undo";
import { useDesk } from "../hub/store";

// The boss's updates as a teammate writes them. Shape A: each piece of work
// in a headline sentence, one or two more with its ids in brackets after,
// what wasn't checked, its session's link, and what the boss did (folded).
// Shape C, the roundup: what happened since the last, by what it means to
// you, each section only when it says something.

const clock = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
};

/** "(MAN-632, MAN-637)", after the words; nothing with no ids. */
const idsOf = (ids?: string[]): string => (ids?.length ? `(${ids.join(", ")})` : "");

/** "Open the session (MAN-632, closed) ›": opens it beside the chat; a
 *  closed one opens read-only, with Resume. */
export function OpenSession({ link, short = false }: { link: SessionLink; short?: boolean }) {
  const label = short ? link.name : `Open the session (${link.name}${link.closed ? ", closed" : ""})`;
  return (
    <button type="button" className="link said-open" onClick={() => openSession(link.sessionId)}>
      {label} ›
    </button>
  );
}

/** "What I did · 3 ›": the boss's own steps on it, each with its Undo. */
function WhatIDid({ did }: { did: readonly BriefItem[] }) {
  const [open, setOpen] = useState(false);
  const list = useId();
  if (!did.length) return null;
  return (
    <>
      <button type="button" className="link said-did" aria-expanded={open} aria-controls={list} onClick={() => setOpen((o) => !o)}>
        What I did · {did.length} {open ? "‹" : "›"}
      </button>
      {open && (
        <ul className="brief-items said-did-list" id={list}>
          {did.map((i) => (
            <Row key={i.id} item={i} />
          ))}
        </ul>
      )}
    </>
  );
}

/** One piece of work, shape A. */
export function SaidItem({ said }: { said: Said }) {
  const ids = idsOf(said.ids);
  return (
    <article className={`said said-${said.kind ?? "progress"}`}>
      <p className="said-head">{said.headline}</p>
      {(said.body || ids) && (
        <p className="said-body">
          {said.body}
          {said.body && ids ? " " : ""}
          {ids && <span className="said-ids">{ids}</span>}
        </p>
      )}
      {said.notChecked && (
        <div className="said-gap">
          <span className="said-gap-label">Not checked</span>
          <p>{said.notChecked}</p>
        </div>
      )}
      {(said.session || (said.did?.length ?? 0) > 0) && (
        <div className="said-links">
          {said.session && <OpenSession link={said.session} />}
          {said.session && (said.did?.length ?? 0) > 0 && <span className="faint"> · </span>}
          <WhatIDid did={said.did ?? []} />
        </div>
      )}
    </article>
  );
}

export function SaidList({ said }: { said: readonly Said[] }) {
  return (
    <div className="said-list">
      {said.map((s, i) => (
        <SaidItem key={s.session?.sessionId ?? `s${i}`} said={s} />
      ))}
    </div>
  );
}

const MARK: Record<RoundupSection["key"], string> = {
  upToYou: "",
  decided: "→",
  finished: "✓",
  worthKnowing: "!",
  stillGoing: "•",
};

/** A decision it made without you: what, why, when, its session, and its
 *  Undo. */
function Decided({ line }: { line: Said }) {
  const connected = useDesk((s) => !!s.hub);
  const [why, setWhy] = useState(false);
  const item = line.did?.[0];
  const { undone, isUndone, fixed, busy, problem, undo } = useUndo(item?.id ?? "", false);
  const can = !!item?.undo && !isUndone && !fixed;
  const ids = idsOf(line.ids);
  // What it did, word for word ("Told the session: …"), on asking.
  const detail = item?.detail ?? null;
  return (
    <li className="rnd-line">
      <span className="rnd-mark decided" aria-hidden>
        {MARK.decided}
      </span>
      <div className="rnd-text">
        <p>
          <span className={isUndone ? "dec-undone" : "rnd-what"}>{line.headline}</span>
          {ids && <span className="said-ids"> {ids}</span>}
          {/* Its "because …", always: the design's one line of why. */}
          {line.body && <span className="brief-why"> {line.body}</span>}
        </p>
        {why && detail && <p className="faint small">{detail}</p>}
        <p className="rnd-meta faint small">
          {clock(line.at)}
          {line.session && (
            <>
              {" · "}
              <OpenSession link={line.session} short />
            </>
          )}
          {detail && (
            <>
              {" · "}
              <button type="button" className="link" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
                {why ? "Less" : "Why?"}
              </button>
            </>
          )}
          {can && item?.undo && (
            <>
              {" · "}
              <button
                type="button"
                className="link"
                disabled={busy || !connected}
                aria-label={`${UNDO_LABEL[item.undo]}: ${line.headline}`}
                onClick={() => void undo()}
              >
                {UNDO_LABEL[item.undo]}
              </button>
            </>
          )}
          {isUndone && <span role="status"> · {undone ? `Undone: ${undone}.` : "Undone."}</span>}
          {problem && (
            <span className="state-blocked" role="alert">
              {" "}
              {problem}
            </span>
          )}
        </p>
      </div>
    </li>
  );
}

/** A run of routine decisions, one line ("Allowed web 16 times, 09:05–09:15:
 *  test and fixture edits, and local test runs."), each of them on "Show
 *  all". */
function Run({ line, decided = false }: { line: Said; decided?: boolean }) {
  const [open, setOpen] = useState(false);
  const list = useId();
  const did = line.did ?? [];
  return (
    <li className="rnd-line">
      <span className={`rnd-mark${decided ? " decided" : ""}`} aria-hidden>
        {decided ? MARK.decided : "·"}
      </span>
      <div className="rnd-text">
        <p>{line.headline}</p>
        <p className="rnd-meta faint small">
          {line.session && <OpenSession link={line.session} short />}
          {line.session && did.length > 0 && " · "}
          {did.length > 0 && (
            <button type="button" className="link" aria-expanded={open} aria-controls={list} onClick={() => setOpen((o) => !o)}>
              {open ? "Hide ‹" : "Show all ›"}
            </button>
          )}
        </p>
        {open && (
          <ul className="brief-items said-did-list" id={list}>
            {did.map((i) => (
              <Row key={i.id} item={i} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/** "16 routine things · Show": what it left out, as runs, on asking; an
 *  older hub's count says to ask. */
function Routine({ count, runs, decided }: { count: number; runs: readonly Said[]; decided: boolean }) {
  const [open, setOpen] = useState(false);
  const list = useId();
  const things = count === 1 ? "1 routine thing" : `${count} routine things`;
  if (!runs.length)
    return (
      <p className="faint small">
        {decided ? "Only decisions that merge, release, delete, spend, override a session or set something to happen later are listed. " : ""}
        {count === 1 ? "1 routine one" : `${count} routine ones`} (nudges, restarts, waits): ask “what else did you decide?”
      </p>
    );
  return (
    <div className="rnd-routine">
      <p className="faint small">
        {things} ·{" "}
        <button type="button" className="link" aria-expanded={open} aria-controls={list} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide ‹" : "Show ›"}
        </button>
      </p>
      {open && (
        <ul className="rnd-lines" id={list}>
          {runs.map((r, i) => (
            <Run key={r.did?.[0]?.id ?? i} line={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Line({ line, mark }: { line: Said; mark: RoundupSection["key"] }) {
  const ids = idsOf(line.ids);
  return (
    <li className="rnd-line">
      <span className={`rnd-mark ${mark}`} aria-hidden>
        {MARK[mark]}
      </span>
      <div className="rnd-text">
        <p>
          <span className="rnd-what">{line.headline}</span>
          {line.body && ` ${line.body}`}
          {ids && <span className="said-ids"> {ids}</span>}
        </p>
        {line.notChecked && <p className="faint small">Not checked: {line.notChecked}</p>}
        {line.session && (
          <p className="rnd-meta small">
            <OpenSession link={line.session} short />
          </p>
        )}
      </div>
    </li>
  );
}

function Section({ section }: { section: RoundupSection }) {
  const head = useId();
  return (
    <section className={`rnd-section rnd-${section.key}`} aria-labelledby={head}>
      <span className="sec-label" id={head}>
        {section.title}
      </span>
      <ul className="rnd-lines">
        {section.lines.map((l, i) =>
          section.key === "decided" && l.kind === "routine" ? (
            <Run key={l.did?.[0]?.id ?? i} line={l} decided />
          ) : section.key === "decided" ? (
            <Decided key={l.did?.[0]?.id ?? i} line={l} />
          ) : (
            <Line key={l.session?.sessionId ?? i} line={l} mark={section.key} />
          ),
        )}
      </ul>
    </section>
  );
}

/** Shape C: "09:00 roundup · since 07:00", the line that matters most, then
 *  its sections. */
export function RoundupBody({ roundup, headline, at }: { roundup: Roundup; headline?: string | null; at?: string }) {
  const routine = roundup.routine ?? 0;
  const decided = roundup.sections.some((s) => s.key === "decided");
  return (
    <div className="rnd">
      <p className="rnd-when faint small">
        {at ? `${clock(at)} roundup` : "Roundup"} · since {clock(roundup.since)}
      </p>
      {headline && <p className="upd-line">{headline}</p>}
      {roundup.sections
        .filter((s) => s.lines.length > 0)
        .map((s) => (
          <Section key={s.key} section={s} />
        ))}
      {routine > 0 && <Routine count={routine} runs={roundup.runs ?? []} decided={decided} />}
    </div>
  );
}
