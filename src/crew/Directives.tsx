import { useCallback, useEffect, useId, useRef, useState } from "react";
import { HubError } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DirectiveQuestion, Directives, DirectivesOpen } from "../hub/types";
import { plainError } from "../ui/plainError";

// Act fully's directives: a few standing answers the boss asks for when Act
// fully goes on ("Can I merge pull requests?"), kept as your preferences for
// it. One card in its DM asks them; the group's Boss sheet lists them to
// change; a quiet update says, at most once a day, which are still open.
// Nothing waits on them: an unanswered one the boss decides itself, and says.

type Loaded = { state: "loading" } | { state: "none" } | { state: "failed"; problem: string } | { state: "ok"; view: Directives };

/** A boss's directives, read live: `boss` is "main" or the group it bosses. */
export function useDirectives(boss: string) {
  const hub = useDesk((s) => s.hub);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const asking = useRef(0);
  const load = useCallback(() => {
    // A hub client without them (a test's, an older hub's) has none.
    if (!hub || typeof hub.directives !== "function") return setLoaded({ state: "none" });
    const n = ++asking.current;
    hub.directives(boss).then(
      (view) => n === asking.current && setLoaded({ state: "ok", view }),
      (e) => {
        if (n !== asking.current) return;
        if (e instanceof HubError && e.status === 404) setLoaded({ state: "none" });
        else setLoaded((was) => (was.state === "ok" ? was : { state: "failed", problem: plainError(e) }));
      },
    );
  }, [hub, boss]);
  useEffect(() => {
    load();
    // Answered in the Boss sheet, or in the chat, while this showed.
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("focus", load);
      asking.current++;
    };
  }, [load]);
  /** Runs a change: the view the hub sends back takes the place of this one. */
  const run = async (what: string, call: () => Promise<Directives>): Promise<boolean> => {
    setBusy(what);
    setProblem(null);
    try {
      const view = await call();
      asking.current++;
      setLoaded({ state: "ok", view });
      return true;
    } catch (e) {
      setProblem(plainError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const h = () => useDesk.getState().hub!;
  return {
    loaded,
    busy,
    problem,
    reload: load,
    answer: (key: string, answer: string | null) => run(key, () => h().answerDirective(boss, key, answer)),
    add: (text: string) => run("own", () => h().addDirective(boss, text)),
    asking: (change: { skipped?: boolean; stop?: boolean }) => run("asking", () => h().directivesAsking(boss, change)),
    forget: (id: string) =>
      run(id, async () => {
        await h().setPreference(id, "retire");
        return h().directives(boss);
      }),
  };
}

type Use = ReturnType<typeof useDirectives>;

/** One question: its answers as chips, one tap each. */
function Row({ q, d, sheet }: { q: DirectiveQuestion; d: Use; sheet: boolean }) {
  const ids = useId();
  const connected = useDesk((s) => !!s.hub);
  const [kept, setKept] = useState(false);
  const pick = async (key: string) => {
    // Your own answer pressed again is no change; one from the main boss
    // pressed is kept for this boss.
    if (key === q.answer && !q.inherited) return;
    if (await d.answer(q.key, key)) setKept(true);
  };
  const keys = (e: React.KeyboardEvent, at: number) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = (at + step + q.answers.length) % q.answers.length;
    const row = (e.currentTarget as HTMLElement).closest('[role="radiogroup"]');
    row?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  const on = q.answers.findIndex((a) => a.key === q.answer);
  const note = kept
    ? "Kept."
    : q.inherited
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
      <div className="chip-row" role="radiogroup" aria-labelledby={`${ids}-q`}>
        {q.answers.map((a, i) => (
          <button
            key={a.key}
            type="button"
            role="radio"
            className={a.key === q.answer ? "chip-btn on" : "chip-btn"}
            aria-checked={a.key === q.answer}
            tabIndex={(on < 0 ? i === 0 : i === on) ? 0 : -1}
            disabled={d.busy !== null || !connected}
            onClick={() => void pick(a.key)}
            onKeyDown={(e) => keys(e, i)}
          >
            {a.label}
          </button>
        ))}
      </div>
      {note && (
        <span className={kept ? "dir-note state-done" : "dir-note"} role={kept ? "status" : undefined}>
          {note}
          {sheet && q.answer && !q.inherited && !kept && (
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
      )}
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

/** The card the boss posts once when Act fully goes on, read live. */
export function DirectivesCard({ boss, inline = false }: { boss: string; inline?: boolean }) {
  const d = useDirectives(boss);
  const [open, setOpen] = useState(false);
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
  return (
    <section className={inline ? "dir-card is-inline" : "msg-text overseer dir-card"} aria-label="Your directives">
      {!inline && (
        <>
          <span className="sec-label">Before I run on my own</span>
          <p className="muted">A few standing answers, so I decide the way you would. One tap each; skip any.</p>
        </>
      )}
      <ul className="dir-list">
        {v.questions.map((q) => (
          <Row key={q.key} q={q} d={d} sheet={false} />
        ))}
      </ul>
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
 *  which unfolds the card under it. */
export function DirectivesOpenLine({ open }: { open: DirectivesOpen }) {
  const [shown, setShown] = useState(false);
  const topics = open.topics ?? [];
  return (
    <div className="dir-open">
      <p className="faint small">
        {open.open === 1 ? "1 directive still open" : `${open.open} directives still open`}
        {topics.length ? `: ${topics.join(", ")}.` : "."}{" "}
        <button type="button" className="link small dir-open-answer" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
          {shown ? "Hide" : "Answer"}
        </button>
      </p>
      {shown && <DirectivesCard boss={open.bossScope} inline />}
    </div>
  );
}

/** The Boss sheet's Directives: each with its answer to change or clear,
 *  your own to forget, one to add, and whether the boss asks again. */
export function BossDirectives({ boss, name }: { boss: string; name: string }) {
  const d = useDirectives(boss);
  const connected = useDesk((s) => !!s.hub);
  if (d.loaded.state === "none" || d.loaded.state === "loading") return null;
  return (
    <div className="oversee-part">
      <h3>Directives</h3>
      <span className="oversee-sub">
        Your standing answers for {name}. They’re orders: they win over its own judgment. Unanswered ones it decides itself, and says so.
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
          <div className="dir-ask" role="radiogroup" aria-label="Ask me about unanswered ones">
            <span className="oversee-sub">Ask me about unanswered ones:</span>
            <span className="chip-row">
              {([false, true] as const).map((stop) => (
                <button
                  key={String(stop)}
                  type="button"
                  role="radio"
                  className={d.loaded.state === "ok" && d.loaded.view.stopAsking === stop ? "chip-btn on" : "chip-btn"}
                  aria-checked={d.loaded.state === "ok" && d.loaded.view.stopAsking === stop}
                  disabled={d.busy !== null || !connected}
                  onClick={() => d.loaded.state === "ok" && d.loaded.view.stopAsking !== stop && void d.asking({ stop })}
                >
                  {stop ? "Stop asking" : "Once a day"}
                </button>
              ))}
            </span>
          </div>
          <Problem d={d} />
        </>
      )}
    </div>
  );
}
