import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { DeskHub } from "../hub/client";
import type { MemoryIndexStatus, MemoryNote, MemoryNotes, MemorySearch, MemorySettings, Session, SessionMemory } from "../hub/types";
import type { ItemKey } from "../groups/model";
import { useLayout } from "../groups/store";
import { plainError } from "../ui/plainError";
import { ForgetMemory } from "./ForgetMemory";
import { useSessionGist } from "./gist";
import { changedFiles, clock, notedByDeskText, providerName, rememberedLine, replacedOf, shortFile } from "./words";

/** What the panel says when the engine keeps no record Desk can read. */
export const NO_RECORD = "Desk can't read this session's conversation, so it remembers only what it's for.";
/** While search isn't ready. */
export const KEYWORD_ONLY = "Searching by keyword only until Desk Memory is ready.";

/** How long after the panel opens it reads again, for the notes Desk was
 *  asked to write as it opened. */
const NOTED_AFTER_MS = 8_000;

interface Loaded {
  memory: SessionMemory | null;
  settings: MemorySettings | null;
  index: MemoryIndexStatus | null;
}

/** Whether search finds by meaning yet. */
export const keywordOnly = (index: MemoryIndexStatus | null): boolean => !index || !index.installed || !!index.failing;

/** "What Desk remembers" of one session: what it's for and where it is, its
 *  notes to confirm, correct or drop, the files it changed, how much is
 *  kept, its Remember switch, search within it, and Forget. */
export function MemoryPanel({ session, name, item, hub }: { session: Session; name: string; item: ItemKey; hub: DeskHub | null }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const gist = useSessionGist(session.id);
  const { groups } = useLayout();
  const group = groups.find((g) => g.items.includes(item)) ?? null;

  const load = useCallback(async () => {
    if (!hub) return;
    try {
      const [memory, settings, index] = await Promise.all([
        hub.sessionMemory(session.id),
        hub.memorySettings().catch(() => null),
        hub.memoryIndex().catch(() => null),
      ]);
      setLoaded({ memory, settings, index });
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
  const settings = loaded?.settings ?? null;

  return (
    <section className="memory-panel" aria-label="What Desk remembers">
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
          <Status memory={m} settings={settings} onResume={() => act(() => hub!.pauseMemory(false), true)} />
          <Notes
            notes={m.notes}
            group={group}
            settings={settings}
            onChange={(id, change) => act(() => hub!.changeNote(id, change))}
            onAllow={(derive) => group && act(() => hub!.changeGroupMemory(group.id, { derive }), derive)}
          />
          <Files files={changedFiles(m.exchanges)} />
          <footer className="memory-foot">
            <p className="small muted">{rememberedLine(m)}</p>
            {m.notice && <p className="small faint">{m.notice}</p>}
            <div className="memory-actions">
              <SearchThisWork hub={hub!} session={session.id} index={loaded.index} />
              {m.counts.exchanges + m.notes.counts.decisions + m.notes.counts.facts + m.notes.counts.todos > 0 && (
                <button type="button" className="btn" onClick={() => setForgetting(true)}>
                  Forget…
                </button>
              )}
              {m.memoryOn !== undefined && (
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
function Status({ memory, settings, onResume }: { memory: SessionMemory; settings: MemorySettings | null; onResume: () => void }) {
  if (memory.remembering || !memory.why) return null;
  return (
    <p className="small memory-status" role="status">
      <span className="muted">{memory.why}</span>
      {settings?.paused && (
        <button type="button" className="link" onClick={onResume}>
          Resume remembering
        </button>
      )}
    </p>
  );
}

type Group = { id: string; name: string };

/** Decisions, still to do and facts, and whether Desk is noting them. */
function Notes({
  notes,
  group,
  settings,
  onChange,
  onAllow,
}: {
  notes: MemoryNotes;
  group: Group | null;
  settings: MemorySettings | null;
  onChange: (id: string, change: Parameters<DeskHub["changeNote"]>[1]) => void;
  onAllow: (derive: boolean) => void;
}) {
  const [explaining, setExplaining] = useState(false);
  const explainId = useId();
  const any = notes.counts.decisions + notes.counts.facts + notes.counts.todos + (notes.replaced?.length ?? 0) > 0;
  const switches = group ? settings?.groups.find((g) => g.id === group.id) : undefined;
  const asking = notes.reason === "group_off" && !!group && !!switches && !switches.deriveDecided;
  // Paused or off for the session is said once, above.
  const said = notes.why && notes.reason !== "memory_off" && !asking ? notes.why : null;
  return (
    <div className="memory-notes">
      {asking && <AskToNote group={group!} provider={notes.provider} onAnswer={onAllow} />}
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
      <NoteList title="Decisions" kind="decision" notes={notes.decisions} replaced={replacedOf(notes, "decision")} onChange={onChange} />
      <NoteList title="Still to do" kind="todo" notes={notes.todos} replaced={replacedOf(notes, "todo")} onChange={onChange} />
      <NoteList title="Facts" kind="fact" notes={notes.facts} replaced={replacedOf(notes, "fact")} onChange={onChange} />
    </div>
  );
}

/** The ask, once per group, before Desk's model reads its sessions (D2). */
function AskToNote({ group, provider, onAnswer }: { group: Group; provider: string | null; onAnswer: (derive: boolean) => void }) {
  const who = providerName(provider);
  return (
    <div className="memory-ask" role="group" aria-label={`Let Desk's model read ${group.name}'s sessions?`}>
      <p className="memory-ask-q">Let Desk's model read {group.name}'s sessions to note decisions?</p>
      <p className="small muted">
        {who ? `What they say is sent to ${who} to note decisions, facts and to-dos.` : "What they say is sent to the model the hub notes with, to note decisions, facts and to-dos."} You can
        change this in the group's memory settings.
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
  onChange,
}: {
  title: string;
  kind: MemoryNote["kind"];
  notes: MemoryNote[];
  replaced: { id: string; text: string; replacedAt: string }[];
  onChange: (id: string, change: Parameters<DeskHub["changeNote"]>[1]) => void;
}) {
  const headId = useId();
  if (notes.length === 0 && replaced.length === 0) return null;
  return (
    <section className="memory-list" aria-labelledby={headId}>
      <h3 id={headId} className="field-label">
        {title} ({notes.length})
      </h3>
      <ul>
        {notes.map((n) => (
          <NoteRow key={n.id} note={n} kind={kind} onChange={onChange} />
        ))}
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

function NoteRow({ note, kind, onChange }: { note: MemoryNote; kind: MemoryNote["kind"]; onChange: (id: string, change: Parameters<DeskHub["changeNote"]>[1]) => void }) {
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
