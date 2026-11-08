// Moving something to another group (boss-gaps W8): where it goes, what that
// does as the hub previews it, the person's choices, and each handover note
// the new boss gets, editable and sent exactly as shown, only on Move.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useBoard, useSessionTicket } from "../board/store";
import { useChat } from "../chat/store";
import { useFloor } from "../floor/store";
import { HubError } from "../hub/client";
import { commitOf, itemKey, MAX_NOTE, movesOf, NO_CHOICES, type Handover, type MoveChoices, type MoveEffect, type MovePreview } from "../hub/moves";
import { useDesk } from "../hub/store";
import { useOverview } from "../overview/store";
import { CloseButton, Dialog } from "../ui/Dialog";
import { AgentMark } from "../ui/Mark";
import { plainError } from "../ui/plainError";
import { bossOfGroup, isSealed } from "./bosses";
import { UNGROUPED } from "./model";
import { afterMove, FIRST_CHOICES, hubGroup, itemOf, localAccount, scopeBoss, useMove, type MoveAsk } from "./move";
import { useLayout } from "./store";

/** How long a change of target settles before it is previewed: each
 *  preview may ask the boss the item leaves to draft its note. */
export const PREVIEW_AFTER_MS = 250;
/** How often a note its old boss is drafting is read again. */
export const DRAFT_POLL_MS = 1500;
/** How long it is read for at most (the hub gives the boss 60 s). */
const DRAFT_POLL_FOR_MS = 75_000;

/** One note as the person has it in the dialog. */
interface Note {
  /** What it is about, so an edit outlives a new preview's ids. */
  item: string;
  /** What is shown, and sent. */
  text: string;
  /** The hub's text as last read. */
  draft: string;
  edited: boolean;
  /** Its old boss's draft came after the person began editing. */
  arrived: boolean;
}

/** Each note of `p`, keeping what the person wrote in `was` (by what it is
 *  about: a new preview gives every note a new id). */
const notesOf = (p: MovePreview | null | undefined, was: Record<string, Note>): Record<string, Note> => {
  if (!p) return {};
  const edited = new Map(Object.values(was).filter((n) => n.edited).map((n) => [n.item, n.text]));
  return Object.fromEntries(
    p.handovers.map((h) => {
      const text = edited.get(h.item);
      return [h.id, { item: h.item, text: text ?? h.note, draft: h.note, edited: text !== undefined, arrived: false }];
    }),
  );
};

/** A refusal in the person's words. */
const said = (e: unknown): string => {
  if (e instanceof HubError) {
    if (e.status === 401 || e.status === 403) return "Only the person who holds this computer’s hub can move things between groups.";
    if (e.status === 404 || e.status === 405) return "This computer’s hub can’t move things between groups yet.";
  }
  return plainError(e);
};

/** Effects that leave something where it was, drawn as staying. */
const STAYS = new Set<MoveEffect["kind"]>(["stays_unassigned", "ledger_stays", "memory_stays", "needs_kept"]);

/** Effects the dialog says in its own place: the question, and why not. */
const ASKED = new Set<MoveEffect["kind"]>(["asks_to_replace", "refused"]);

/** What a move that changes nothing past where it is says. */
const NOTHING_ELSE: Record<MoveAsk["subject"]["kind"], (name: string) => string> = {
  session: (name) => `Only where ${name} shows in the sidebar changes: the same boss oversees both groups.`,
  agent: (name) => `Only where ${name} shows in the sidebar changes.`,
  ticket: (name) => `Nothing else changes for ${name}.`,
  room: (name) => `Only the group ${name} belongs to changes: the same boss oversees both.`,
  boss: (name) => `Nothing changes for ${name}.`,
};

const NOT_CONNECTED = "Desk isn’t connected to this computer’s hub just now; try again in a moment.";

/** The dialog, while a move is asked for. */
export function MoveDialog() {
  const asking = useMove((s) => s.asking);
  const close = useMove((s) => s.close);
  if (!asking) return null;
  const s = asking.subject;
  return <MoveDialogFor key={`${s.kind}:${s.kind === "agent" ? s.agent.id : s.id}`} ask={asking} onClose={close} />;
}

function MoveDialogFor({ ask, onClose }: { ask: MoveAsk; onClose: () => void }) {
  const { subject } = ask;
  const ids = useId();
  const layout = useLayout();
  const manager = useOverview((s) => s.manager);
  const roster = useChat((s) => s.roster);
  const hubs = useChat((s) => s.hubs);
  const local = hubs.find((h) => h.local);
  const plans = useFloor((s) => (local ? s.hubs[local.id]?.floor?.plans : undefined));
  const ticket = useSessionTicket(subject.kind === "session" ? subject.id : null);
  const fail = useDesk((s) => s.fail);

  const [to, setTo] = useState<string | null>(ask.to && ask.to !== subject.from ? ask.to : null);
  const [choices, setChoices] = useState<MoveChoices>(ask.preview?.choices ?? (subject.kind === "session" ? FIRST_CHOICES : NO_CHOICES));
  const [preview, setPreview] = useState<MovePreview | null>(ask.preview ?? null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, Note>>(() => notesOf(ask.preview, {}));
  const [sendProblem, setSendProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether the choices are real ones here: seen once in a preview.
  const [ticketCanGo, setTicketCanGo] = useState(() => !!ask.preview?.effects.some((e) => e.kind === "ticket_goes"));
  const [bossCanRun, setBossCanRun] = useState(() => !!ask.preview?.effects.some((e) => e.kind === "charge_to"));

  const isLocal = (hubId: string) => !!hubs.find((h) => h.id === hubId)?.local;
  const mainBoss = manager?.agentId ?? null;
  /** A boss by its agent id, by name: never the id. */
  const bossName = (id: string | null | undefined): string => {
    const who = id ?? mainBoss;
    if (!who) return "Desk";
    return (
      roster.find((a) => a.id === who && isLocal(a.hubId))?.name ??
      manager?.bosses?.find((b) => b.agentId === who)?.name ??
      (who === "desk" ? "Desk" : who === mainBoss ? "the main boss" : "its boss")
    );
  };
  const groupName = (id: string | null | undefined): string =>
    !id || id === UNGROUPED ? "Ungrouped" : (layout.groups.find((g) => g.id === id)?.name ?? "another group");
  /** Who runs what is in `group`, as its option says. */
  const runsIt = (group: string): string => {
    const own = group !== UNGROUPED ? bossOfGroup(manager, group) : null;
    if (own) return `${own.name} runs it`;
    if (group !== UNGROUPED && isSealed(manager, group)) return "nobody oversees it";
    if (!mainBoss) return "no boss";
    return group === UNGROUPED ? `${bossName(mainBoss)} runs it` : `no boss of its own · ${bossName(mainBoss)} runs it`;
  };

  // ── Previews ───────────────────────────────────────────────────────────
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useCallback(
    async (target: string, c: MoveChoices): Promise<void> => {
      const item = itemOf(subject);
      if (!item) return;
      const hub = localAccount();
      const n = ++seq.current;
      setProblem(null);
      setSendProblem(null);
      if (!hub) {
        setPreview(null);
        return setProblem(NOT_CONNECTED);
      }
      setLoading(true);
      try {
        const p = await movesOf(hub).preview(item, hubGroup(target), c);
        if (n !== seq.current) return;
        setPreview(p);
        setNotes((was) => notesOf(p, was));
        if (p.effects.some((e) => e.kind === "ticket_goes")) setTicketCanGo(true);
        if (p.effects.some((e) => e.kind === "charge_to")) setBossCanRun(true);
      } catch (e) {
        if (n !== seq.current) return;
        setPreview(null);
        setProblem(said(e));
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [subject],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  // The first look, unless the way in made it.
  useEffect(() => {
    if (to && !ask.preview && subject.kind !== "agent") void request(to, choices);
    // Only once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickTarget = (target: string) => {
    if (target === to) return;
    setTo(target);
    setNotice(null);
    if (subject.kind === "agent") return;
    // A boss asked to replace one group's boss isn't asked for another's.
    const c = { ...choices, replace: false };
    setChoices(c);
    setPreview(null);
    clearTimeout(timer.current);
    seq.current++;
    setLoading(true);
    timer.current = setTimeout(() => void request(target, c), PREVIEW_AFTER_MS);
  };
  const choose = (change: Partial<MoveChoices>) => {
    const c = { ...choices, ...change };
    setChoices(c);
    setNotice(null);
    if (to) void request(to, c);
  };

  // ── Notes its old boss is still drafting ──────────────────────────────
  const drafting = preview?.handovers.filter((h) => h.drafting).map((h) => h.id) ?? [];
  const draftingKey = drafting.join(",");
  useEffect(() => {
    if (!draftingKey) return;
    const hub = localAccount();
    if (!hub) return;
    const left = new Set(draftingKey.split(","));
    const since = Date.now();
    const read = async () => {
      for (const id of [...left]) {
        let h: Handover;
        try {
          h = await movesOf(hub).handover(id);
        } catch {
          continue;
        }
        if (!h.drafting) left.delete(id);
        setPreview((p) => (p ? { ...p, handovers: p.handovers.map((x) => (x.id === id ? { ...x, ...h } : x)) } : p));
        setNotes((was) => {
          const n = was[id];
          if (!n || n.draft === h.note) return was;
          return { ...was, [id]: n.edited ? { ...n, draft: h.note, arrived: true } : { ...n, text: h.note, draft: h.note } };
        });
      }
      if (!left.size || Date.now() - since > DRAFT_POLL_FOR_MS) clearInterval(every);
    };
    const every = setInterval(() => void read(), DRAFT_POLL_MS);
    return () => clearInterval(every);
  }, [draftingKey]);

  // ── Moving ─────────────────────────────────────────────────────────────
  const notesOk = !!preview && preview.handovers.every((h) => {
    const t = notes[h.id]?.text ?? h.note;
    return t.trim().length > 0 && [...t].length <= MAX_NOTE;
  });
  const asksToReplace = preview?.effects.find((e) => e.kind === "asks_to_replace") ?? null;
  const refused = preview?.effects.find((e) => e.kind === "refused") ?? null;
  const canMove =
    !!to && !busy && !loading && (subject.kind === "agent" ? true : !!preview && !preview.blocked && notesOk);

  const move = async () => {
    if (!to || !canMove) return;
    if (subject.kind === "agent") {
      ask.apply?.(to);
      return onClose();
    }
    const hub = localAccount();
    if (!hub || !preview) return setSendProblem(NOT_CONNECTED);
    setBusy(true);
    setSendProblem(null);
    try {
      const done = await movesOf(hub).commit(commitOf(preview, (h) => notes[h.id]?.text ?? h.note));
      onClose();
      ask.placed?.(to);
      if (done.problems.length) fail(new Error(`${subject.name} moved to ${groupName(to)}, but ${done.problems.join(" ")}`));
      void afterMove(subject.kind);
      if (subject.kind === "ticket") void useBoard.getState().load();
    } catch (e) {
      setBusy(false);
      if (e instanceof HubError && e.status === 409) {
        // What it does changed, or it ran out: look again, keeping what
        // the person wrote.
        setNotice(e.message);
        return void request(to, choices);
      }
      setSendProblem(said(e));
    }
  };

  // ── What's said ────────────────────────────────────────────────────────
  const fromBoss = scopeBoss(manager, subject.from);
  const handover = preview?.effects.find((e) => e.kind === "handover") ?? null;
  const newBoss = handover?.to ?? preview?.effects.find((e) => e.kind === "charge_to")?.boss ?? null;
  const toOwnBoss = !!to && to !== UNGROUPED && !!bossOfGroup(manager, to);
  const targets = [
    ...layout.groups.map((g) => g.id),
    // A boss oversees a group; Ungrouped is the main boss's.
    ...(subject.kind === "boss" ? [] : [UNGROUPED]),
  ];
  const shownEffects = preview?.effects.filter((e) => !ASKED.has(e.kind)) ?? [];
  const agentEffect = (): string => {
    if (!to) return "";
    const was = fromBoss;
    const now = scopeBoss(manager, to);
    if (was === now) return `Only where ${subject.name} shows in the sidebar changes.`;
    if (!now) return `Nobody oversees ${subject.name} in ${groupName(to)}: it’s closed to everyone but you.`;
    return `${bossName(now)} oversees ${subject.name} from now on${was ? `, not ${bossName(was)}` : ""}. Only where it shows in the sidebar changes otherwise.`;
  };
  const planGoal = (item: string): string | null => {
    const id = item.startsWith("plan:") ? item.slice(5) : null;
    return id ? (plans?.find((p) => p.id === id)?.goal ?? null) : null;
  };
  const noteLabel = (h: Handover): string => {
    if (preview && h.item === itemKey(preview.item)) return "Handover note";
    const goal = planGoal(h.item);
    return goal ? `Note on the plan “${goal}”` : "Note on one of its plans";
  };
  const drafter = (h: Handover, n: Note | undefined): string => {
    if (n?.edited) return "Edited by you";
    if (h.drafting) return `${bossName(h.fromBoss)} is writing it; this is what Desk knows meanwhile`;
    if (h.draftedBy.kind === "desk") return "Written by Desk from what it knows";
    return `Drafted by ${roster.find((a) => a.id === h.draftedBy.id && isLocal(a.hubId))?.name ?? h.draftedBy.name}`;
  };

  const now = subject.from;
  const sub =
    subject.kind === "boss"
      ? `Oversees ${groupName(now)} now`
      : `Now in ${groupName(now)}${fromBoss ? `, run by ${bossName(fromBoss)}` : ""}`;

  return (
    <Dialog
      onClose={onClose}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              Move {subject.name}
            </h1>
            <p className="small">{sub}</p>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-scroll move-body">
        <fieldset className="move-field">
          <legend>{subject.kind === "boss" ? "To oversee" : "To"}</legend>
          <div className="move-opts" role="radiogroup" aria-label="To">
            {targets.map((g) => {
              const here = g === now;
              const own = g !== UNGROUPED ? bossOfGroup(manager, g) : null;
              const runner = own?.agentId ?? (g === UNGROUPED || !isSealed(manager, g) ? mainBoss : null);
              const runnerAgent = runner ? roster.find((a) => a.id === runner && isLocal(a.hubId)) : undefined;
              return (
                <label key={g} className="move-opt">
                  <input type="radio" name={`${ids}-to`} value={g} checked={to === g} disabled={here} onChange={() => pickTarget(g)} />
                  <span className="move-opt-lead" aria-hidden="true">
                    {runnerAgent ? <AgentMark agent={`${runnerAgent.hubId}/${runnerAgent.id}`} name={runnerAgent.name} size="sm" /> : <span className="move-opt-mark" />}
                  </span>
                  <span className="move-opt-main">
                    <span>{groupName(g)}</span>
                    <span className="move-opt-sub">{here ? `where it is now · ${runsIt(g)}` : runsIt(g)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {subject.kind === "session" && to && (ticketCanGo || choices.ticketGoes === false) && ticket && (
          <fieldset className="move-field">
            <legend>Its ticket{ticket.key ? `, ${ticket.key}` : ""}</legend>
            <div className="move-opts" role="radiogroup" aria-label="Its ticket">
              <label className="move-opt">
                <input type="radio" name={`${ids}-ticket`} checked={choices.ticketGoes} disabled={loading} onChange={() => choose({ ticketGoes: true })} />
                <span className="move-opt-main">
                  <span>Goes with it</span>
                  <span className="move-opt-sub">
                    to {groupName(to)}’s board with a new key; its history stays with {groupName(now)}
                  </span>
                </span>
              </label>
              <label className="move-opt">
                <input type="radio" name={`${ids}-ticket`} checked={!choices.ticketGoes} disabled={loading} onChange={() => choose({ ticketGoes: false })} />
                <span className="move-opt-main">
                  <span>Stays on {groupName(now)}’s board</span>
                  <span className="move-opt-sub">back in To do, unassigned</span>
                </span>
              </label>
            </div>
          </fieldset>
        )}

        {subject.kind === "session" && to && (bossCanRun || choices.release) && (
          <fieldset className="move-field">
            <legend>Who runs it</legend>
            <div className="move-opts" role="radiogroup" aria-label="Who runs it">
              <label className="move-opt">
                <input type="radio" name={`${ids}-run`} checked={!choices.release} disabled={loading} onChange={() => choose({ release: false })} />
                <span className="move-opt-main">
                  <span>{bossName(scopeBoss(manager, to))} runs it</span>
                  <span className="move-opt-sub">as {groupName(to)}’s boss</span>
                </span>
              </label>
              <label className="move-opt">
                <input type="radio" name={`${ids}-run`} checked={choices.release} disabled={loading} onChange={() => choose({ release: true })} />
                <span className="move-opt-main">
                  <span>You run it on your own</span>
                  <span className="move-opt-sub">no boss runs it after the move</span>
                </span>
              </label>
            </div>
          </fieldset>
        )}

        {notice && (
          <p className="move-callout" role="status">
            {notice}
          </p>
        )}

        {to && (
          <section className="move-field" aria-label="What happens">
            <h2 className="move-legend">What happens</h2>
            {subject.kind === "agent" ? (
              <ul className="move-effects">
                <li>
                  <Arrow />
                  <span>{agentEffect()}</span>
                </li>
              </ul>
            ) : loading && !preview ? (
              <p className="faint small">Looking at what this does…</p>
            ) : problem ? (
              <p className="small state-blocked" role="alert">
                {problem}
              </p>
            ) : preview ? (
              <>
                {asksToReplace && (
                  <div className="move-ask" role="group" aria-label="Replace its boss?">
                    <p>{asksToReplace.text}</p>
                    <button type="button" className="btn btn-signal" disabled={loading} onClick={() => choose({ replace: true })}>
                      Replace {bossName(asksToReplace.boss)}
                    </button>
                  </div>
                )}
                {refused && (
                  <p className="move-callout move-refused" role="alert">
                    {refused.text}
                  </p>
                )}
                {!asksToReplace && !refused && shownEffects.length === 0 && <p className="small muted">{NOTHING_ELSE[subject.kind](subject.name)}</p>}
                {shownEffects.length > 0 && (
                  <ul className="move-effects">
                    {shownEffects.map((e, i) => (
                      <li key={`${e.kind}-${i}`} className={STAYS.has(e.kind) ? "stay" : ""}>
                        {STAYS.has(e.kind) ? <Stay /> : <Arrow />}
                        <span>{e.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </section>
        )}

        {preview &&
          !preview.blocked &&
          preview.handovers.map((h) => {
            const n = notes[h.id];
            const text = n?.text ?? h.note;
            const count = [...text].length;
            const noteId = `${ids}-note-${h.id}`;
            return (
              <div key={h.id} className="move-field">
                <label className="move-legend" htmlFor={noteId}>
                  {noteLabel(h)}
                </label>
                <textarea
                  id={noteId}
                  className="move-note"
                  value={text}
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.target.value;
                    setNotes((was) => ({ ...was, [h.id]: { ...(was[h.id] ?? { item: h.item, draft: h.note, arrived: false }), text: v, edited: true } }));
                  }}
                />
                <div className="move-note-meta small">
                  <span>
                    {drafter(h, n)} · <b>{bossName(h.toBoss)} receives only this note</b>, not the transcript
                  </span>
                  <span className={count > MAX_NOTE ? "state-blocked" : ""}>
                    {count} / {MAX_NOTE}
                  </span>
                </div>
                {n?.arrived && (
                  <button
                    type="button"
                    className="link small"
                    onClick={() => setNotes((was) => ({ ...was, [h.id]: { ...n, text: n.draft, edited: false, arrived: false } }))}
                  >
                    {bossName(h.fromBoss)}’s draft came in: use it instead
                  </button>
                )}
              </div>
            );
          })}

        {preview && !preview.blocked && handover && (
          <p className="move-callout">
            {toOwnBoss
              ? `${groupName(to)} is another client. This note is all ${bossName(handover.to)} gets from ${groupName(now)}: edit anything ${bossName(handover.to)} shouldn’t see before you move it.`
              : `This note is all ${bossName(handover.to)} gets from ${groupName(now)}: edit anything ${bossName(handover.to)} shouldn’t see before you move it.`}
          </p>
        )}
        {preview && !preview.blocked && subject.kind === "session" && newBoss && (
          <p className="move-callout">
            From now on {bossName(newBoss)} sees {subject.name} as it is: its goal, its last reply and its terminal. Its past messages
            {fromBoss ? ` with ${bossName(fromBoss)}` : ""} and {groupName(now)}’s activity stay with {groupName(now)}.
          </p>
        )}
      </div>
      <footer className="dialog-foot move-foot">
        <span className="dialog-foot-note state-blocked" role={sendProblem ? "alert" : undefined}>
          {sendProblem}
        </span>
        <button type="button" className="btn btn-ghost" data-autofocus onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-signal" disabled={!canMove} onClick={() => void move()}>
          {busy ? "Moving…" : to ? `Move to ${groupName(to)}` : "Move"}
        </button>
      </footer>
    </Dialog>
  );
}

const Arrow = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M2 7h9M8 4l3 3-3 3" />
  </svg>
);

const Stay = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="7" cy="7" r="4" />
  </svg>
);
