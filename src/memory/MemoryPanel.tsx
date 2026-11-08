import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { DeskHub } from "../hub/client";
import { machineOf } from "../hub/machines";
import { engineListeners } from "../hub/store";
import type { MemoryIndexStatus, MemoryNote, MemoryNotes, MemorySearch, Session, SessionMemory } from "../hub/types";
import { LOCAL, useMachines } from "../machines/engines";
import { plainError } from "../ui/plainError";
import { ForgetMemory } from "./ForgetMemory";
import { useSessionGist } from "./gist";
import { changedFiles, clock, fallbackText, notedByDeskText, providerName, rememberedLine, replacedOf, shortFile } from "./words";

/** What the panel says when the engine keeps no record Desk can read. */
export const NO_RECORD = "Desk can't read this session's conversation, so it remembers only what it's for.";
/** While search isn't ready. */
export const KEYWORD_ONLY = "Searching by keyword only until Desk Memory is ready.";

/** How long after the panel opens it reads again, for the notes Desk was
 *  asked to write as it opened. */
const NOTED_AFTER_MS = 8_000;
/** How long a dropped note can be had back before it goes. */
export const UNDO_MS = 5_000;

interface Loaded {
  memory: SessionMemory | null;
  index: MemoryIndexStatus | null;
}

/** Whether search finds by meaning yet. */
export const keywordOnly = (index: MemoryIndexStatus | null): boolean => !index || !index.installed || !!index.failing;

/** "What Desk remembers" of one session: what it's for and where it is, its
 *  notes to confirm, correct or drop, the files it changed, how much is
 *  kept, its Remember switch, search within it, and Forget. */
export function MemoryPanel({
  session,
  name,
  hub,
  id,
  labelledBy,
}: {
  session: Session;
  name: string;
  /** The session's own hub: this computer's, or its machine's. */
  hub: DeskHub | null;
  id?: string;
  labelledBy?: string;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const gist = useSessionGist(session.id);
  const machine = machineOf(session);
  const machineName = useMachines((s) => (machine === LOCAL ? null : (s.machines.find((x) => x.id === machine)?.name ?? machine)));

  const load = useCallback(async () => {
    if (!hub) return;
    try {
      const [memory, index] = await Promise.all([hub.sessionMemory(session.id), hub.memoryIndex().catch(() => null)]);
      setLoaded({ memory, index });
      setProblem(null);
    } catch (e) {
      setProblem(plainError(e));
    }
  }, [hub, session.id]);

  // Notes are made due as the panel opens, and again whenever the person
  // lets Desk note (a switch turned on clears what was due); read again
  // once they may be written.
  const again = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noteNow = useCallback(() => {
    if (!hub) return;
    void hub.deriveMemory(session.id).catch(() => undefined);
    clearTimeout(again.current);
    again.current = setTimeout(() => void load(), NOTED_AFTER_MS);
  }, [hub, session.id, load]);
  useEffect(() => {
    noteNow();
    void load();
    return () => clearTimeout(again.current);
  }, [noteNow, load]);
  // A switch changed anywhere (Settings, a group's menu, another window)
  // on the session's own hub: read again.
  useEffect(() => {
    const heard = (e: { type: string; machine?: string }) => {
      if (e.type === "setting" && machineOf(e) === machine) void load();
    };
    engineListeners.add(heard);
    return () => void engineListeners.delete(heard);
  }, [load, machine]);

  /** Runs a change, then reads again; `letsNote`, a change that may let
   *  Desk note again, makes the session's notes due first. */
  const act = async (run: () => Promise<unknown>, letsNote = false) => {
    try {
      await run();
      setProblem(null);
      if (letsNote) noteNow();
    } catch (e) {
      setProblem(plainError(e));
    }
    await load();
  };

  const purpose = gist?.purpose ?? (session.goal || null);
  const m = loaded?.memory ?? null;
  // A machine's groups aren't this computer's sidebar's: none to set yet.
  const group = machineName ? null : (m?.switches?.group ?? null);

  return (
    <section className="memory-panel" role="tabpanel" id={id} aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : "What Desk remembers"}>
      <dl className="memory-gist">
        <dt>What it's for</dt>
        <dd>
          {purpose ?? <span className="faint">Not said yet.</span>}
          {gist && <span className="faint small memory-when">updated {clock(gist.at)}</span>}
        </dd>
        {gist?.now && (
          <>
            <dt>Where it is</dt>
            <dd>{gist.now}</dd>
          </>
        )}
      </dl>

      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}

      {!loaded ? (
        <p className="faint small">Loading…</p>
      ) : m?.noRecord ? (
        <p className="muted small memory-status">{NO_RECORD}</p>
      ) : !m ? (
        <p className="muted small memory-status">Desk hasn't remembered anything of this session yet.</p>
      ) : (
        <>
          <Status memory={m} onResume={() => act(() => hub!.pauseMemory(false), true)} />
          <Notes
            notes={m.notes}
            group={group}
            machineName={machineName}
            onChange={(note, change) => act(() => hub!.changeNote(note, change))}
            onAllow={(derive) => group && act(() => hub!.changeGroupMemory(group.id, { derive }), derive)}
          />
          <Files files={changedFiles(m.exchanges)} />
          <footer className="memory-foot">
            <p className="small muted">{rememberedLine(m)}</p>
            {m.notice && <p className="small faint">{m.notice}</p>}
            <div className="memory-actions">
              <SearchThisWork hub={hub!} session={session.id} index={loaded.index} />
              {m.counts.exchanges + (m.notes.counts.kept ?? m.notes.counts.decisions + m.notes.counts.facts + m.notes.counts.todos) > 0 && (
                <button type="button" className="btn" onClick={() => setForgetting(true)}>
                  Forget…
                </button>
              )}
              {m.memoryOn !== undefined && !m.cleared && (
                <RememberSwitch on={m.memoryOn} onChange={(on) => act(() => hub!.rememberSession(session.id, on), on)} />
              )}
            </div>
          </footer>
          {forgetting && (
            <ForgetMemory
              name={name}
              memory={m}
              engine={session.engine}
              onForget={async () => {
                await hub!.forgetMemory(session.id);
                await load();
              }}
              onClose={() => setForgetting(false)}
            />
          )}
        </>
      )}
    </section>
  );
}

/** Why what the session says now isn't remembered, when it isn't. */
function Status({ memory, onResume }: { memory: SessionMemory; onResume: () => void }) {
  if (memory.remembering || !memory.why) return null;
  return (
    <p className="small memory-status" role="status">
      <span className="muted">{memory.why}</span>
      {memory.switches?.paused && (
        <button type="button" className="link" onClick={onResume}>
          Resume remembering
        </button>
      )}
    </p>
  );
}

type Group = { id: string; name: string; deriveDecided: boolean };
type Change = Parameters<DeskHub["changeNote"]>[1];

/** Decisions, still to do and facts, and whether Desk is noting them. A
 *  dropped note can be had back for a few seconds before it goes. */
function Notes({
  notes,
  group,
  machineName,
  onChange,
  onAllow,
}: {
  notes: MemoryNotes;
  group: Group | null;
  /** The machine the session runs on, when it isn't this computer. */
  machineName: string | null;
  onChange: (id: string, change: Change) => void;
  onAllow: (derive: boolean) => void;
}) {
  const [explaining, setExplaining] = useState(false);
  const explainId = useId();
  const [dropping, setDropping] = useState<string[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const send = useRef(onChange);
  send.current = onChange;
  // Leaving the panel drops what was waiting to be.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const [id, t] of pending) {
        clearTimeout(t);
        send.current(id, { action: "drop" });
      }
      pending.clear();
    };
  }, []);
  const drop = (id: string) => {
    setDropping((d) => [...d, id]);
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setDropping((d) => d.filter((x) => x !== id));
        send.current(id, { action: "drop" });
      }, UNDO_MS),
    );
  };
  const undo = (id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setDropping((d) => d.filter((x) => x !== id));
  };
  const change = (id: string, c: Change) => (c.action === "drop" ? drop(id) : onChange(id, c));

  const any = notes.counts.decisions + notes.counts.facts + notes.counts.todos + (notes.replaced?.length ?? 0) > 0;
  const groupOff = notes.reason === "group_off";
  const asking = groupOff && !!group && !group.deriveDecided;
  const elsewhere = groupOff && !!machineName;
  // Paused or off for the session is said once, above.
  const said = notes.why && notes.reason !== "paused" && notes.reason !== "session_off" && !asking && !elsewhere ? notes.why : null;
  const list = { dropping, onUndo: undo, onChange: change };
  return (
    <div className="memory-notes">
      {asking && <AskToNote group={group!} notes={notes} onAnswer={onAllow} />}
      {elsewhere && (
        <p className="small muted memory-status" role="status">
          Desk doesn't note decisions from this session's group. Memory settings for {machineName}'s sessions come later.
        </p>
      )}
      {said && (
        <p className="small muted memory-status" role="status">
          {said}
        </p>
      )}
      {any && (
        <div className="memory-noted-by">
          <button type="button" className="link small" aria-expanded={explaining} aria-controls={explainId} onClick={() => setExplaining((x) => !x)}>
            noted by Desk <span aria-hidden="true">ⓘ</span>
          </button>
          {explaining && (
            <p id={explainId} className="small muted memory-explain">
              {notedByDeskText(notes)}
            </p>
          )}
        </div>
      )}
      <NoteList title="Decisions" kind="decision" notes={notes.decisions} replaced={replacedOf(notes, "decision")} {...list} />
      <NoteList title="Still to do" kind="todo" notes={notes.todos} replaced={replacedOf(notes, "todo")} {...list} />
      <NoteList title="Facts" kind="fact" notes={notes.facts} replaced={replacedOf(notes, "fact")} {...list} />
    </div>
  );
}

/** The ask, once per group, before Desk's model reads its sessions (D2). */
function AskToNote({ group, notes, onAnswer }: { group: Group; notes: Pick<MemoryNotes, "provider" | "fallbackProviders">; onAnswer: (derive: boolean) => void }) {
  const who = providerName(notes.provider);
  return (
    <div className="memory-ask" role="group" aria-label={`Let Desk's model read ${group.name}'s sessions?`}>
      <p className="memory-ask-q">Let Desk's model read {group.name}'s sessions to note decisions?</p>
      <p className="small muted">
        {who ? `What they say is sent to ${who} to note decisions, facts and to-dos.` : "What they say is sent to the model the hub notes with, to note decisions, facts and to-dos."}
        {notes.fallbackProviders && ` ${fallbackText}`} You can change this in the group's memory settings.
      </p>
      <div className="memory-ask-actions">
        <button type="button" className="btn btn-signal" onClick={() => onAnswer(true)}>
          Let it read them
        </button>
        <button type="button" className="btn" onClick={() => onAnswer(false)}>
          Not for {group.name}
        </button>
      </div>
    </div>
  );
}

function NoteList({
  title,
  kind,
  notes,
  replaced,
  dropping,
  onUndo,
  onChange,
}: {
  title: string;
  kind: MemoryNote["kind"];
  notes: MemoryNote[];
  replaced: { id: string; text: string; replacedAt: string }[];
  /** Notes dropped a moment ago, to be had back. */
  dropping: string[];
  onUndo: (id: string) => void;
  onChange: (id: string, change: Change) => void;
}) {
  const headId = useId();
  if (notes.length === 0 && replaced.length === 0) return null;
  const held = notes.filter((n) => !dropping.includes(n.id)).length;
  return (
    <section className="memory-list" aria-labelledby={headId}>
      <h3 id={headId} className="field-label">
        {title} ({held})
      </h3>
      <ul>
        {notes.map((n) =>
          dropping.includes(n.id) ? (
            <li key={n.id} className="memory-note memory-note-replaced" role="status">
              <span className="memory-bullet" aria-hidden="true" />
              <span className="memory-note-text small">
                Dropped “{n.text}”.{" "}
                <button type="button" className="link" onClick={() => onUndo(n.id)}>
                  Undo
                </button>
              </span>
            </li>
          ) : (
            <NoteRow key={n.id} note={n} kind={kind} onChange={onChange} />
          ),
        )}
        {replaced.slice(0, 3).map((r) => (
          <li key={r.id} className="memory-note memory-note-replaced">
            <span className="memory-bullet" aria-hidden="true">
              {kind === "todo" ? "○" : "•"}
            </span>
            <span className="memory-note-text">
              <s>{r.text}</s> <span className="faint small">(replaced {clock(r.replacedAt)})</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NoteRow({ note, kind, onChange }: { note: MemoryNote; kind: MemoryNote["kind"]; onChange: (id: string, change: Change) => void }) {
  const [correcting, setCorrecting] = useState(false);
  const [text, setText] = useState(note.text);
  const done = note.state === "done";
  const save = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    setCorrecting(false);
    if (t && t !== note.text) onChange(note.id, { action: "correct", text: t });
  };
  return (
    <li className={`memory-note ${done ? "memory-note-done" : ""}`}>
      <span className="memory-bullet" aria-hidden="true">
        {kind === "todo" ? (done ? "●" : "○") : "•"}
      </span>
      {correcting ? (
        <form className="memory-correct" onSubmit={save}>
          <input
            autoFocus
            aria-label="What the note should say"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setText(note.text);
                setCorrecting(false);
              }
            }}
          />
          <button type="submit" className="link small">
            Save
          </button>
          <button
            type="button"
            className="link small"
            onClick={() => {
              setText(note.text);
              setCorrecting(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <span className="memory-note-text">
          {note.text}
          {done && <span className="faint small"> done</span>}
          {note.sourceGone && <span className="faint small"> · source no longer kept</span>}
          <span className="memory-note-actions small">
            {note.confirmed ? (
              <span className="faint">{note.notedByDesk ? "confirmed" : "yours"}</span>
            ) : (
              <button type="button" className="link" onClick={() => onChange(note.id, { action: "confirm" })}>
                Confirm
              </button>
            )}
            <span className="faint" aria-hidden="true">
              ·
            </span>
            <button type="button" className="link" onClick={() => setCorrecting(true)}>
              Correct
            </button>
            <span className="faint" aria-hidden="true">
              ·
            </span>
            <button type="button" className="link" onClick={() => onChange(note.id, { action: "drop" })}>
              Drop
            </button>
          </span>
        </span>
      )}
    </li>
  );
}

/** The files it changed: their names, and every path when opened. */
function Files({ files }: { files: string[] }) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;
  const shown = files.slice(0, 4).map(shortFile).join(", ");
  return (
    <div className="memory-files">
      <span className="field-label">Files it changed</span>
      <button type="button" className="link small memory-files-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {shown}
        {files.length > 4 ? ` and ${files.length - 4} more` : ""} <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="memory-file-list small mono">
          {files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RememberSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <span className="memory-remember">
      <span id={id} className="small">
        Remember
      </span>
      <button type="button" role="switch" className="switch" aria-checked={on} aria-labelledby={id} onClick={() => onChange(!on)}>
        <span className="switch-knob" />
      </button>
    </span>
  );
}

/** Search within this session's memory: a simple filter. */
function SearchThisWork({ hub, session, index }: { hub: DeskHub; session: string; index: MemoryIndexStatus | null }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<MemorySearch | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    try {
      setFound(await hub.searchMemory({ q: q.trim(), session, limit: 20 }));
      setProblem(null);
    } catch (x) {
      setProblem(plainError(x));
    }
  };
  if (!open)
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Search this work
      </button>
    );
  const keywords = found ? found.keywordOnly : keywordOnly(index);
  return (
    <div className="memory-search">
      <form role="search" aria-label="Search this work" onSubmit={search}>
        <input autoFocus type="search" aria-label="Search this work" placeholder="Search what it said and noted" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="btn">
          Search
        </button>
      </form>
      {keywords && <p className="small faint">{found?.notice ?? KEYWORD_ONLY}</p>}
      {problem && (
        <p className="small state-blocked" role="alert">
          {problem}
        </p>
      )}
      {found &&
        (found.hits.length === 0 ? (
          <p className="small faint">Nothing found.</p>
        ) : (
          <ul className="memory-hits">
            {found.hits.map((h, i) => (
              <li key={`${h.at}:${i}`}>
                <span className="faint small">
                  {HIT_KIND[h.kind]} · {clock(h.at)}
                </span>
                <span className="memory-hit-text">{h.kind === "exchange" || h.kind === "compaction" ? (h.ask ? `“${h.ask}” … ${h.answer}` : h.answer) : h.answer}</span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

const HIT_KIND: Record<MemorySearch["hits"][number]["kind"], string> = {
  exchange: "Conversation",
  compaction: "Summary",
  decision: "Decision",
  fact: "Fact",
  todo: "To do",
};
