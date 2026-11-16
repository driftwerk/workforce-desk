import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { type DeskHub, HubError } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DirectiveQuestion, Directives, DirectivesOpen } from "../hub/types";
import { plainError } from "../ui/plainError";

// Act fully's directives: a few standing answers the boss asks for when Act
// fully goes on ("Can I merge pull requests?"), kept as your preferences for
// it. One card in its DM asks them; the group's Boss sheet lists them to
// change; a quiet update says, at most once a day, which are still open.
// Nothing waits on them: an unanswered one the boss decides itself, and says.

type Loaded = { state: "loading" } | { state: "none" } | { state: "failed"; problem: string } | { state: "ok"; view: Directives };

/** What every card, line and sheet of one boss reads: its directives as last
 *  read, and which of its cards in the DM is the newest. */
interface Snapshot {
  loaded: Loaded;
  newest: string | null;
}

const LOADING: Snapshot = { loaded: { state: "loading" }, newest: null };
const NONE: Snapshot = { loaded: { state: "none" }, newest: null };

/** One boss's directives on one hub, shared by all that show them: read once
 *  when the first shows, again each time Desk comes back to the front while
 *  any does, and replaced by the view each change sends back. Changes go to
 *  the hub one at a time, so the last view is the last change's. */
class Shared {
  private snap: Snapshot = LOADING;
  private subs = new Set<() => void>();
  private seq = 0;
  /** The read in flight, while it still counts. */
  private reading: number | null = null;
  private users = 0;
  private writes: Promise<unknown> = Promise.resolve();
  /** The DM's cards showing, by message id, with when each was posted. */
  private cards = new Map<string, number>();

  constructor(
    private hub: DeskHub,
    private boss: string,
  ) {}

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  };
  get = () => this.snap;
  private set(change: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...change };
    this.subs.forEach((fn) => fn());
  }

  load = () => {
    // A hub client without them (a test's, an older hub's) has none.
    if (typeof this.hub.directives !== "function") return this.set({ loaded: { state: "none" } });
    if (this.reading === this.seq) return;
    const n = ++this.seq;
    this.reading = n;
    this.hub
      .directives(this.boss)
      .then(
        (view) => n === this.seq && this.set({ loaded: { state: "ok", view } }),
        (e) => {
          if (n !== this.seq) return;
          if (e instanceof HubError && e.status === 404) this.set({ loaded: { state: "none" } });
          else if (this.snap.loaded.state !== "ok") this.set({ loaded: { state: "failed", problem: plainError(e) } });
        },
      )
      .finally(() => {
        if (this.reading === n) this.reading = null;
      });
  };

  /** Shown somewhere: read now, and again on focus (answered in the Boss
   *  sheet, or in the chat, while it showed), until nothing shows it. */
  use = () => {
    if (this.users++ === 0) {
      this.load();
      window.addEventListener("focus", this.load);
    }
    return () => {
      if (--this.users > 0) return;
      window.removeEventListener("focus", this.load);
      this.seq++;
    };
  };

  /** A change, after any before it: its view takes the place of what was
   *  read (and of any read still out). */
  write(call: () => Promise<Directives>): Promise<Directives> {
    const done = this.writes.then(call);
    this.writes = done.catch(() => undefined);
    return done.then((view) => {
      this.seq++;
      this.set({ loaded: { state: "ok", view } });
      return view;
    });
  }

  /** A card in the DM: only the newest one asks, so turning Act fully off
   *  and on leaves one live card, not several. */
  card(id: string, at: string) {
    this.cards.set(id, Date.parse(at) || 0);
    this.pickNewest();
    return () => {
      this.cards.delete(id);
      this.pickNewest();
    };
  }
  private pickNewest() {
    let newest: string | null = null;
    let when = -Infinity;
    for (const [id, at] of this.cards)
      if (at > when || (at === when && newest !== null && id > newest)) {
        newest = id;
        when = at;
      }
    if (newest !== this.snap.newest) this.set({ newest });
  }
}

const shared = new WeakMap<DeskHub, Map<string, Shared>>();
const sharedOf = (hub: DeskHub, boss: string): Shared => {
  let bosses = shared.get(hub);
  if (!bosses) shared.set(hub, (bosses = new Map()));
  let s = bosses.get(boss);
  if (!s) bosses.set(boss, (s = new Shared(hub, boss)));
  return s;
};
const nothing = () => () => undefined;

/** A boss's directives, read live: `boss` is "main" or the group it bosses. */
export function useDirectives(boss: string) {
  const hub = useDesk((s) => s.hub);
  const s = hub ? sharedOf(hub, boss) : null;
  const snap = useSyncExternalStore(s ? s.subscribe : nothing, s ? s.get : () => NONE);
  useEffect(() => s?.use(), [s]);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Runs a change: the view the hub sends back takes the place of this one. */
  const run = async (what: string, call: (hub: DeskHub) => Promise<Directives>): Promise<boolean> => {
    const now = useDesk.getState().hub;
    if (!now) return false;
    setBusy(what);
    setProblem(null);
    try {
      await sharedOf(now, boss).write(() => call(now));
      return true;
    } catch (e) {
      setProblem(plainError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return {
    loaded: snap.loaded,
    newest: snap.newest,
    shared: s,
    busy,
    problem,
    reload: () => s?.load(),
    answer: (key: string, answer: string | null) => run(key, (h) => h.answerDirective(boss, key, answer)),
    add: (text: string) => run("own", (h) => h.addDirective(boss, text)),
    asking: (change: { skipped?: boolean; stop?: boolean }) => run("asking", (h) => h.directivesAsking(boss, change)),
    forget: (id: string) =>
      run(id, async (h) => {
        await h.setPreference(id, "retire");
        return h.directives(boss);
      }),
  };
}

type Use = ReturnType<typeof useDirectives>;

/** How long "Kept." shows on a question once its answer is kept. */
export const KEPT_MS = 2500;

/** Answers as chips, one radio group: a tap or Space or Enter chooses one;
 *  the arrow keys (and Home and End) move to the next and choose it, as
 *  radios do. Only the chosen one is a tab stop. The chips stay focusable
 *  while a choice is saved, so the keyboard never loses its place. */
function Chips({
  options,
  value,
  onPick,
  offline,
  ...label
}: {
  options: readonly { key: string; label: string }[];
  value: string | null;
  onPick: (key: string) => void;
  offline: boolean;
} & ({ "aria-labelledby": string } | { "aria-label": string })) {
  const on = options.findIndex((o) => o.key === value);
  const keys = (e: React.KeyboardEvent<HTMLButtonElement>, at: number) => {
    const n = options.length;
    const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined || offline) return;
    e.preventDefault();
    const next = (to + n) % n;
    e.currentTarget.closest('[role="radiogroup"]')?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
    onPick(options[next]!.key);
  };
  return (
    <span className="chip-row" role="radiogroup" {...label}>
      {options.map((o, i) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          className={o.key === value ? "chip-btn on" : "chip-btn"}
          aria-checked={o.key === value}
          tabIndex={(on < 0 ? i === 0 : i === on) ? 0 : -1}
          disabled={offline}
          onClick={() => onPick(o.key)}
          onKeyDown={(e) => keys(e, i)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** One question: its answers as chips, one tap each. The chip shows chosen
 *  at once; the latest choice is saved after any still saving, then
 *  "Kept." shows a moment. */
function Row({ q, d, sheet }: { q: DirectiveQuestion; d: Use; sheet: boolean }) {
  const ids = useId();
  const connected = useDesk((s) => !!s.hub);
  const [chosen, setChosen] = useState<string | null>(null);
  const want = useRef<string | null>(null);
  const saving = useRef(false);
  const [kept, setKept] = useState(false);
  const keptFor = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(keptFor.current), []);
  const value = chosen ?? q.answer;
  const save = async () => {
    saving.current = true;
    let ok = true;
    while (ok && want.current !== null) {
      const key = want.current;
      want.current = null;
      ok = await d.answer(q.key, key);
    }
    want.current = null;
    saving.current = false;
    // The view says it now; or, not kept, says what is.
    setChosen(null);
    if (!ok) return;
    // Set with "Kept." itself, so it goes KEPT_MS after it came.
    setKept(true);
    clearTimeout(keptFor.current);
    keptFor.current = setTimeout(() => setKept(false), KEPT_MS);
  };
  const pick = (key: string) => {
    // Your own answer pressed again is no change; one from the main boss
    // pressed is kept for this boss.
    if (key === value && (chosen !== null || !q.inherited)) return;
    setChosen(key);
    want.current = key;
    if (!saving.current) void save();
  };
  const note = kept
    ? "Kept."
    : q.inherited && chosen === null
      ? "From Desk’s main boss"
      : sheet && q.answer
        ? q.applied === 0
          ? "Not used yet"
          : q.applied === 1
            ? "Used once"
            : `Used ${q.applied} times`
        : null;
  return (
    <li className="dir-row">
      <span className="dir-q" id={`${ids}-q`}>
        {q.question}
      </span>
      <Chips options={q.answers} value={value} onPick={pick} offline={!connected} aria-labelledby={`${ids}-q`} />
      {/* Always there, so "Kept." is heard as it comes. */}
      <span className={kept ? "dir-note state-done" : "dir-note"} role="status">
        {note}
        {note && sheet && q.answer && !q.inherited && !kept && (
          <>
            {" · "}
            <button
              type="button"
              className="link"
              disabled={d.busy !== null || !connected}
              onClick={() => void d.answer(q.key, null)}
              aria-label={`Clear: ${q.question}`}
            >
              Clear
            </button>
          </>
        )}
      </span>
    </li>
  );
}

/** "Add your own…": one line and Add. */
function AddOwn({ d, placeholder }: { d: Use; placeholder: string }) {
  const [text, setText] = useState("");
  const connected = useDesk((s) => !!s.hub);
  const blank = !text.trim();
  return (
    <form
      className="dir-own"
      onSubmit={(e) => {
        e.preventDefault();
        if (!blank) void d.add(text.trim()).then((ok) => ok && setText(""));
      }}
    >
      <input aria-label="Add a directive of your own" placeholder={placeholder} value={text} maxLength={300} onChange={(e) => setText(e.target.value)} />
      <button type="submit" className="btn btn-sm" disabled={blank || d.busy !== null || !connected}>
        {d.busy === "own" ? "Adding…" : "Add"}
      </button>
    </form>
  );
}

function Problem({ d }: { d: Use }) {
  if (!d.problem) return null;
  return (
    <p className="small state-blocked" role="alert">
      {d.problem}
    </p>
  );
}

/** The card the boss posts once when Act fully goes on, read live. In the
 *  DM, `message` is the post it is: only the newest card for a boss asks,
 *  and an older one folds to a line. Unfolded `inline` under an update's
 *  line, it shows the questions open when it was unfolded, with Show all. */
export function DirectivesCard({ boss, inline = false, message }: { boss: string; inline?: boolean; message?: { id: string; at: string } }) {
  const d = useDirectives(boss);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const openAt = useRef<ReadonlySet<string> | null>(null);
  const { shared: s } = d;
  const id = message?.id;
  const at = message?.at;
  useEffect(() => (s && id && at && !inline ? s.card(id, at) : undefined), [s, id, at, inline]);
  if (d.loaded.state === "loading") return null;
  if (d.loaded.state === "none") return <p className="faint small">Answer in this chat.</p>;
  if (d.loaded.state === "failed")
    return (
      <p className="small state-blocked" role="alert">
        {d.loaded.problem}{" "}
        <button type="button" className="link" onClick={d.reload}>
          Try again
        </button>
      </p>
    );
  // Asked again further down (Act fully off and on again): this one folds.
  if (id && !inline && d.newest !== null && d.newest !== id)
    return (
      <div className="msg-text overseer">
        <p className="faint small">Asked again further down.</p>
      </div>
    );
  const v = d.loaded.view;
  const left = v.questions.filter((q) => !q.answer).length;
  // Skipped: folded to one line, opened again on asking. Unfolded inline
  // from an update's line, it shows whole.
  if (v.skipped && !open && !inline)
    return (
      <div className="msg-text overseer">
        <p className="faint small" role="status">
          Skipped. I’ll ask again another day, or answer in the Boss sheet.{" "}
          <button type="button" className="link small" onClick={() => setOpen(true)}>
            Answer now
          </button>
        </p>
      </div>
    );
  // Those open when it was unfolded stay, answered or not, so a row
  // answered here keeps its place (and its focus, and its "Kept.").
  if (inline && openAt.current === null) openAt.current = new Set(v.questions.filter((q) => !q.answer).map((q) => q.key));
  const only = inline && !all && openAt.current && openAt.current.size > 0 && openAt.current.size < v.questions.length ? openAt.current : null;
  const questions = only ? v.questions.filter((q) => only.has(q.key)) : v.questions;
  return (
    <section className={inline ? "dir-card is-inline" : "msg-text overseer dir-card"} aria-label="Your directives">
      {!inline && (
        <>
          <span className="sec-label">Before I run on my own</span>
          <p className="muted">A few standing answers, so I decide the way you would. One tap each; skip any.</p>
        </>
      )}
      <ul className="dir-list">
        {questions.map((q) => (
          <Row key={q.key} q={q} d={d} sheet={false} />
        ))}
      </ul>
      {only && (
        <p className="faint small">
          <button type="button" className="link small dir-show-all" onClick={() => setAll(true)}>
            Show all {v.questions.length}
          </button>
        </p>
      )}
      {v.own.length > 0 && <p className="faint small">Your own: {v.own.map((o) => o.text).join(" · ")}</p>}
      <AddOwn d={d} placeholder="Add your own, e.g. Never touch the billing service" />
      <Problem d={d} />
      <div className="dir-foot">
        {left > 0 && !inline && (
          <button type="button" className="link small" disabled={d.busy !== null} onClick={() => void d.asking({ skipped: true }).then(() => setOpen(false))}>
            Skip for now
          </button>
        )}
        {left > 0 && !v.stopAsking && (
          <button type="button" className="link small" disabled={d.busy !== null} onClick={() => void d.asking({ stop: true })}>
            Stop asking
          </button>
        )}
        <span className="faint small">
          {left === 0 ? "All answered. " : v.stopAsking ? "I won’t ask again. " : ""}
          Change these any time in the Boss sheet.
        </span>
      </div>
    </section>
  );
}

/** The one line an update adds on the directives still open, with Answer,
 *  which unfolds the card under it. Read live: an old update says what is
 *  open now, and nothing once all are answered. Until the directives are
 *  read, it says what the update said. */
export function DirectivesOpenLine({ open }: { open: DirectivesOpen }) {
  const [shown, setShown] = useState(false);
  const d = useDirectives(open.bossScope);
  const live = d.loaded.state === "ok" ? d.loaded.view.questions.filter((q) => !q.answer) : null;
  const n = live ? live.length : open.open;
  const topics = live ? live.map((q) => q.topic) : (open.topics ?? []);
  // All answered (here, in the sheet, or in the chat): nothing to say, unless
  // it is unfolded, where the answers just given stay in view.
  if (n === 0 && !shown) return null;
  return (
    <div className="dir-open">
      <p className="faint small">
        {n === 0 ? "All directives answered." : n === 1 ? "1 directive still open" : `${n} directives still open`}
        {n > 0 && (topics.length ? `: ${topics.join(", ")}.` : ".")}{" "}
        <button type="button" className="link small dir-open-answer" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
          {shown ? "Hide" : "Answer"}
        </button>
      </p>
      {shown && <DirectivesCard boss={open.bossScope} inline />}
    </div>
  );
}

const ASKING = [
  { key: "daily", label: "Once a day" },
  { key: "stop", label: "Stop asking" },
] as const;

/** The Boss sheet's Directives: each with its answer to change or clear,
 *  your own to forget, one to add, and whether the boss asks again. */
export function BossDirectives({ boss, name, shared = false }: { boss: string; name: string; shared?: boolean }) {
  const d = useDirectives(boss);
  const connected = useDesk((s) => !!s.hub);
  const [stopWant, setStopWant] = useState<boolean | null>(null);
  const asks = useRef(0);
  if (d.loaded.state === "none" || d.loaded.state === "loading") return null;
  return (
    <div className="oversee-part dir-section">
      <h3>Directives</h3>
      <span className="oversee-sub">
        Your standing answers for {name}. They’re orders: they win over its own judgment. Unanswered ones it decides itself, and says so.
        {shared && " These are Desk’s main boss’s, for every group it runs."}
      </span>
      {d.loaded.state === "failed" ? (
        <p className="small state-blocked" role="alert">
          {d.loaded.problem}{" "}
          <button type="button" className="link" onClick={d.reload}>
            Try again
          </button>
        </p>
      ) : (
        <>
          <ul className="dir-list" aria-label="Directives">
            {d.loaded.view.questions.map((q) => (
              <Row key={q.key} q={q} d={d} sheet />
            ))}
          </ul>
          {d.loaded.view.own.length > 0 && (
            <>
              <span className="sec-label">Your own</span>
              <ul className="dir-list" aria-label="Your own directives">
                {d.loaded.view.own.map((o) => (
                  <li key={o.id} className="dir-row dir-own-row">
                    <span>{o.text}</span>
                    {o.inherited ? (
                      <span className="dir-note">From Desk’s main boss</span>
                    ) : (
                      <button
                        type="button"
                        className="link small"
                        aria-label={`Forget: ${o.text}`}
                        disabled={d.busy !== null || !connected}
                        onClick={() => void d.forget(o.id)}
                      >
                        Forget
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <AddOwn d={d} placeholder="Add your own…" />
          <div className="dir-ask">
            <span className="oversee-sub">Ask me about unanswered ones:</span>
            <Chips
              options={ASKING}
              value={(stopWant ?? d.loaded.view.stopAsking) ? "stop" : "daily"}
              offline={!connected}
              aria-label="Ask me about unanswered ones"
              onPick={(key) => {
                if (d.loaded.state !== "ok") return;
                const stop = key === "stop";
                if (stop === (stopWant ?? d.loaded.view.stopAsking)) return;
                // Chosen at once, as a radio is; the hub's view takes over
                // once the last choice is saved.
                setStopWant(stop);
                const n = ++asks.current;
                void d.asking({ stop }).finally(() => n === asks.current && setStopWant(null));
              }}
            />
          </div>
          <Problem d={d} />
        </>
      )}
    </div>
  );
}
