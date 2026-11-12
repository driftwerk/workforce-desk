import { useEffect, useMemo, useRef, useState } from "react";
import { useBoard } from "../board/store";
import { ENGINE_TITLE } from "../engines/engines";
import { useDesk } from "../hub/store";
import type { PlanBudget, BossPlan, BossPlanDetail, BossPlanTicket, DraftTicket, Engine, EngineInfo, OnPlanDrop } from "../hub/types";
import { useLocalAgent } from "../overview/people";
import { homeShort } from "../ui/paths";
import { plainError } from "../ui/plainError";
import { amountText, parseAmount, standingText } from "../spend/budgets";
import {
  awaiting,
  budgetText,
  capOf,
  sameBudget,
  changesBetween,
  draftOf,
  liveCard,
  liveTickets,
  needChoices,
  ownWorktrees,
  pausedWhy,
  progress,
  progressLine,
  resumable,
  revisionOf,
  ruled,
  segments,
  standing,
  started,
  waves,
  waveTitle,
  withoutTicket,
  working,
  type PlanChanges,
} from "./plan";
import { usePlans } from "./planStore";

/** The engines a plan's ticket may run on, as the hub reads this computer:
 *  each with why it can't, when it can't. */
export interface EngineChoice {
  engine: Engine;
  title: string;
  /** Why it can't run a plan's ticket here; none when it can. */
  not: string | null;
}

/** What each engine of `engines` says about running a plan's ticket: it is
 *  installed, signed in, and has a line for its boss (as the hub checks a
 *  plan); with no list (an older hub), Claude Code and Codex. */
export const engineChoices = (engines: readonly EngineInfo[] | null): EngineChoice[] => {
  if (engines === null) return (["claude", "codex"] as const).map((engine) => ({ engine, title: ENGINE_TITLE[engine], not: null }));
  return engines
    .filter((e) => e.engine !== "custom")
    .map((e) => {
      const view = e.views[0];
      const caps = view ? e.caps[view] : undefined;
      const not =
        !e.program || e.installed === false
          ? "not installed"
          : e.signIn.state === "out"
            ? "signed out"
            : !view
              ? "can't start here"
              : caps?.line === "none"
                ? "no line for a boss"
                : null;
      return { engine: e.engine, title: ENGINE_TITLE[e.engine] ?? e.title, not };
    });
};

/** This computer's engines, read once for every plan card. */
let enginesRead: Promise<EngineInfo[] | null> | null = null;
const useEngines = (): EngineChoice[] | null => {
  const hub = useDesk((s) => s.hub);
  const [list, setList] = useState<EngineChoice[] | null>(null);
  useEffect(() => {
    if (!hub) return;
    let live = true;
    enginesRead ??= hub.engines().catch(() => null);
    void enginesRead.then((e) => live && setList(engineChoices(e)));
    return () => {
      live = false;
    };
  }, [hub]);
  return list;
};
// Another hub: its engines are its own.
useDesk.subscribe((now, before) => {
  if (now.hub !== before.hub) enginesRead = null;
});

/** The engine picker of a ticket not started yet. */
function EngineSelect({ value, choices, label, disabled, onChange }: { value: Engine; choices: EngineChoice[]; label: string; disabled?: boolean; onChange: (e: Engine) => void }) {
  const known = choices.some((c) => c.engine === value) ? choices : [{ engine: value, title: ENGINE_TITLE[value], not: null }, ...choices];
  return (
    <select className="pc-engine" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Engine)}>
      {known.map((c) => (
        <option key={c.engine} value={c.engine} disabled={!!c.not && c.engine !== value}>
          {c.not ? `${c.title} (${c.not})` : c.title}
        </option>
      ))}
    </select>
  );
}

/** A boss's plan as its DM shows it: posted by the boss when it proposed or
 *  changed it. The newest card posted for a plan shows it whole (its goal,
 *  waves, each ticket's engine and folder, where it stands, and what the
 *  person may do with it); older ones say only what that revision changed. */
export function PlanCard({ mentioned, text }: { mentioned: { id: string; revision: number }; text?: string }) {
  const { id } = mentioned;
  const supported = usePlans((s) => s.supported);
  const detail = usePlans((s) => s.details[id]);
  const summary = usePlans((s) => s.plans[id]);
  const unread = usePlans((s) => s.unread[id]);
  const posted = usePlans((s) => s.cards[id]);
  const hub = useDesk((s) => s.hub);

  useEffect(() => usePlans.getState().showCard(id, mentioned.revision), [id, mentioned.revision]);
  useEffect(() => {
    if (hub && supported !== false && !usePlans.getState().details[id]) void usePlans.getState().fetch(id);
  }, [hub, supported, id]);

  if (!detail) {
    return (
      <div className="dm-action pc-notice" role="group" aria-label="Plan">
        <span className="dm-action-text">
          {text && <span className="pc-fallback">{text}</span>}
          <span className="small faint">{supported === false ? "This version of Desk can't show plans yet: update Desk to approve it here." : unread ? `Desk couldn't read this plan: ${unread}` : "Reading the plan…"}</span>
        </span>
      </div>
    );
  }
  const plan = { ...detail, ...(summary && summary.updatedAt >= detail.updatedAt ? summary : {}) };
  if (!liveCard(posted ?? [], mentioned.revision)) return <RevisionNotice detail={detail} plan={plan} revision={mentioned.revision} text={text} />;
  return <WholePlan detail={detail} plan={plan} />;
}

/** An older card of a plan: what that revision changed, by whom. */
function RevisionNotice({ detail, plan, revision, text }: { detail: BossPlanDetail; plan: BossPlan; revision: number; text?: string }) {
  const r = revisionOf(detail, revision);
  const who = useLocalAgent(r?.by.kind === "manager" || r?.by.kind === "agent" ? r.by.id : null)?.name ?? (r?.by.kind === "you" ? "You" : r?.by.name);
  return (
    <div className="dm-action pc-notice" role="group" aria-label={`Plan revision ${revision}`}>
      <span className="dm-action-text">
        <span>
          <span className="chip">rev {revision}</span> {r ? `${who}: ${r.summary}` : text}
        </span>
        <span className="small faint">The plan is at revision {plan.revision} now: see its newest card below.</span>
      </span>
    </div>
  );
}

type Asking = null | "approve" | "turnDown" | "continue" | "pause" | "resume" | "drop" | "save" | "engine";

function WholePlan({ detail, plan }: { detail: BossPlanDetail; plan: BossPlan }) {
  const board = useBoard((s) => s.tickets);
  const boardName = useBoard((s) => s.boards[plan.board]?.name);
  const boss = useLocalAgent(plan.boss)?.name || plan.bossName || "The boss";
  const refusal = usePlans((s) => s.refusals[plan.id]);
  const choices = useEngines();
  const [asking, setAsking] = useState<Asking>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<DraftTicket[] | null>(null);
  // Dropping: "ask" until the person says what becomes of its sessions.
  const [dropping, setDropping] = useState<OnPlanDrop | "ask" | null>(null);
  // The cap the person approves a proposed plan with, in dollars: the
  // boss's proposal to start with ("" is none).
  const proposedCap = plan.budget && plan.budget.unit === "usd" ? String(plan.budget.amount) : "";
  const [cap, setCap] = useState(proposedCap);
  // When it warns and what it does when over: the proposal's, else 80% and
  // pause new starts.
  const [warnAt, setWarnAt] = useState(plan.budget?.warnAt ?? 0.8);
  const [onExceed, setOnExceed] = useState<PlanBudget["onExceed"]>(plan.budget?.onExceed ?? "pause");
  useEffect(() => {
    setCap(proposedCap);
    setWarnAt(plan.budget?.warnAt ?? 0.8);
    setOnExceed(plan.budget?.onExceed ?? "pause");
  }, [proposedCap, plan.budget?.warnAt, plan.budget?.onExceed]);

  const tickets = useMemo(() => liveTickets(detail, board), [detail, board]);
  const rules = useMemo(() => tickets.map(ruled), [tickets]);
  const byId = useMemo(() => new Map(rules.map((t) => [t.id, t] as const)), [rules]);
  const shownWaves = useMemo(() => waves(rules), [rules]);
  const own = useMemo(() => ownWorktrees(shownWaves, byId), [shownWaves, byId]);
  const now = useMemo(() => progress(rules), [rules]);
  const stand = standing(plan);
  const waitsOnYou = awaiting(plan);
  const change = waitsOnYou && plan.approvedRevision !== null ? revisionOf(detail, detail.revision) : undefined;
  // Everything approving the change would approve, each part in full.
  const approvedSnapshot = plan.approvedRevision !== null ? revisionOf(detail, plan.approvedRevision)?.snapshot : undefined;
  const changes = change && approvedSnapshot ? changesBetween(approvedSnapshot, change.snapshot) : null;
  // Each ticket by its key where it has one, else its title.
  const ticketNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of detail.revisions) for (const t of r.snapshot.tickets) m.set(t.id, `“${t.title}”`);
    for (const t of detail.tickets) if (t.key) m.set(t.id, t.key);
    return m;
  }, [detail]);
  // A newer revision was announced than the one read: nothing is decided on
  // the older one shown until it is read.
  const stale = plan.revision > detail.revision;
  // The person has seen this revision: what approving it approves (the
  // change, else the tickets) was on screen, or Look brought it there. The
  // Floor may approve it then, and not before.
  const changeRef = useRef<HTMLDivElement>(null);
  const ticketsRef = useRef<HTMLDivElement>(null);
  // Its budget and Approve: seen too, so the cap is never approved unseen.
  const footRef = useRef<HTMLDivElement>(null);
  const looking = usePlans((s) => !!s.looking[plan.id]);
  useEffect(() => {
    const el = changeRef.current ?? ticketsRef.current;
    const foot = footRef.current;
    if (!el || stale) return;
    const id = plan.id;
    const revision = detail.revision;
    const store = usePlans.getState();
    if (looking) {
      (el.closest("article") ?? el).scrollIntoView?.({ block: "center" });
      store.looked(id);
      store.saw(id, revision);
      return;
    }
    if (typeof IntersectionObserver === "undefined") return;
    // Each part must have been on screen: what it changes, and its budget.
    const parts = [el, ...(foot ? [foot] : [])];
    const shown = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (inView(e)) shown.add(e.target);
        if (parts.every((p) => shown.has(p))) {
          usePlans.getState().saw(id, revision);
          io.disconnect();
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    parts.forEach((p) => io.observe(p));
    return () => io.disconnect();
  }, [stale, plan.id, detail.revision, looking, !!change]);
  const ended = plan.state === "done" || plan.state === "dropped";
  // The newest revision's tickets: an edit is made from them, so a change
  // the boss proposes is never lost by one.
  const newest = revisionOf(detail, detail.revision)?.snapshot.tickets;
  const draft = (): DraftTicket[] =>
    newest
      ? draftOf(newest)
      : draftOf(tickets.map((t) => ({ id: t.id, title: t.title, body: t.body, engine: t.engine ?? "claude", folder: t.folder ?? "", view: t.view, needs: t.needs })));

  const run = async (what: Exclude<Asking, null>, request: () => Promise<void>) => {
    setAsking(what);
    setProblem(null);
    try {
      await request();
      return true;
    } catch (e) {
      // A refusal the store explains (a newer revision, the hub's words) is
      // shown from there.
      if (!usePlans.getState().refusals[plan.id]) setProblem(plainError(e));
      return false;
    } finally {
      setAsking(null);
    }
  };
  const store = usePlans.getState();
  // Approving, turning a change down and going on are the person's own,
  // answered as the Floor answers them.
  // A proposal's cap as typed: the proposal's kept as it is (nothing
  // sent), another amount, or none (its budget taken off).
  const capAmount = parseAmount(cap, "usd");
  const capProblem = plan.approvedRevision === null && cap.trim() !== "" && capAmount === null ? "Say the cap in dollars, like 40." : null;
  const typedCap = capAmount !== null ? capOf(capAmount, plan.budget, { warnAt, onExceed }) : null;
  const capSent: PlanBudget | null | undefined =
    plan.approvedRevision !== null
      ? undefined
      : cap.trim() === ""
        ? plan.budget
          ? null
          : undefined
        : typedCap && !sameBudget(typedCap, plan.budget)
          ? typedCap
          : undefined;
  const approvedCap = capSent === undefined ? (plan.budget ?? null) : capSent;
  const approve = () => void run("approve", () => store.decide(plan.id, detail.revision, "allow", capSent));
  const turnDown = () => void run("turnDown", () => store.decide(plan.id, detail.revision, "deny"));
  const goOn = () => void run("continue", () => store.decide(plan.id, detail.revision, "allow"));
  // Its starts kept failing: the person says whether it goes on.
  const failing = plan.state === "paused" && plan.paused === "start_failing";
  const save = async (tickets: DraftTicket[]) => {
    const ok = await run("save", () => store.edit(plan.id, { revision: detail.revision, tickets }));
    // Refused because the plan changed: what was being edited is gone,
    // and the newer revision is shown to edit again.
    if (ok || usePlans.getState().refusals[plan.id]?.from !== undefined) setEditing(null);
  };
  const setEngine = (ticket: string, engine: Engine) => {
    const tickets = draft().map((t) => (t.id === ticket ? { ...t, engine } : t));
    void run("engine", () => store.edit(plan.id, { revision: detail.revision, tickets }));
  };
  const drop = async (sessions: OnPlanDrop) => {
    if (await run("drop", () => store.drop(plan.id, sessions))) setDropping(null);
  };

  const busy = asking !== null;
  const sessionsRun = working(tickets);
  return (
    <article className="plancard" aria-label={`Plan: ${plan.goal}`}>
      <div className="pc-head">
        <div className="pc-row">
          <h4 className="pc-title">{plan.goal}</h4>
          <span className={`chip pc-chip-${stand.look}`}>{plan.state === "paused" && plan.paused ? `Paused: ${pausedWhy(plan)}` : stand.text}</span>
          <span className="chip" title={stale ? `Revision ${plan.revision} is being read` : undefined}>
            rev {detail.revision}
          </span>
        </div>
        <span className="muted small">
          {[boardName ? `Board: ${boardName}` : null, `${boss}'s plan`].filter(Boolean).join(" · ")}
        </span>
      </div>

      {refusal && (
        <div className="pc-notice-line" role="alert">
          <span>{refusal.text}</span>
          <button type="button" className="link small" onClick={() => store.clear(plan.id)}>
            Got it
          </button>
        </div>
      )}
      {change && (
        <div ref={changeRef} className="pc-change" role="group" aria-label="A change to the plan">
          <span>
            <b>{boss}</b> wants to change the plan: {change.summary}
          </span>
          {changes && <ChangeDetails changes={changes} names={ticketNames} />}
          <span className="small muted">
            A change of scope, so it needs you. The plan keeps running on revision {plan.approvedRevision} meanwhile.
          </span>
        </div>
      )}
      {plan.held && !ended && (
        <div className="pc-notice-line" role="status">
          <span>
            New starts are held: {plan.held}. Continue on the Floor lets them start again.
            {detail.spend?.period === "total" && detail.spend.status === "over"
              ? " Continued while it is over a budget for the whole plan, the plan runs uncapped for the rest of its run."
              : ""}
          </span>
        </div>
      )}
      {stale && (
        <div className="pc-notice-line" role="status">
          <span>Revision {plan.revision} has come: reading it before anything is approved.</span>
        </div>
      )}

      {(plan.state === "running" || plan.state === "paused" || plan.state === "done") && (
        <div className="pc-progress">
          <span className="muted small">
            {progressLine(now)}
            {plan.state === "paused" && plan.paused && <span className="pc-paused"> · new starts paused: {pausedWhy(plan)}</span>}
          </span>
          {detail.spend && (
            <span className="muted small">
              Spent {standingText(detail.spend)}
              {detail.spend.shared ? ", shared by the plan's sessions" : ""}
            </span>
          )}
          <div className="pc-segbar" role="img" aria-label={segments(now).map((s) => `${s.n} ${s.kind}`).join(", ") || "nothing yet"}>
            {segments(now).map((s) => (
              <i key={s.kind} className={`pc-s-${s.kind}`} style={{ flex: s.n }} />
            ))}
          </div>
          <div className="pc-legend">
            {segments(now).map((s) => (
              <span key={s.kind}>
                <i className={`pc-s-${s.kind}`} />
                {s.n} {s.kind}
              </span>
            ))}
          </div>
        </div>
      )}

      {editing ? (
        <PlanEditor
          draft={editing}
          choices={choices ?? engineChoices(null)}
          lockedIds={new Set(tickets.filter(started).map((t) => t.id))}
          busy={busy}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={(t) => void save(t)}
        />
      ) : (
        <div ref={ticketsRef} className="pc-waves">
        {shownWaves.map((wave, i) => {
          const title = waveTitle(i, shownWaves, byId);
          return (
            <div key={i} className="pc-wave">
              <div className="pc-wave-label">
                {title.label}
                {title.note && <span className="pc-wave-note"> · {title.note}</span>}
              </div>
              {wave.map((tid) => {
                const t = tickets.find((x) => x.id === tid);
                return t ? (
                  <TicketRow
                    key={tid}
                    t={t}
                    all={tickets}
                    own={own.has(tid)}
                    choices={plan.state === "proposed" && !started(t) ? choices : null}
                    disabled={busy}
                    onEngine={(e) => setEngine(t.id, e)}
                  />
                ) : null;
              })}
            </div>
          );
        })}
        </div>
      )}

      {!ended && (
        <div ref={footRef} className="pc-foot">
          <div className="pc-facts">
            <span className="chip">
              {now.total} ticket{now.total === 1 ? "" : "s"}
            </span>
            {plan.parallel !== null && <span className="chip">up to {plan.parallel} at once</span>}
            {plan.budget && <span className="chip">cap {budgetText(plan.budget)}</span>}
          </div>
          {dropping ? (
            <div className="pc-drop" role="group" aria-label="Drop the plan">
              {sessionsRun ? (
                <fieldset className="pc-drop-choice">
                  <legend className="small">Its sessions working now</legend>
                  <label className="opt">
                    <input type="radio" name={`drop-${plan.id}`} checked={dropping === "stop"} onChange={() => setDropping("stop")} />
                    <span>Stop them</span>
                  </label>
                  <label className="opt">
                    <input type="radio" name={`drop-${plan.id}`} checked={dropping === "leave"} onChange={() => setDropping("leave")} />
                    <span>Leave them running, yours to finish</span>
                  </label>
                </fieldset>
              ) : (
                <span className="small muted">Its tickets not done are dropped from the board.</span>
              )}
              <span className="pc-actions">
                <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => !busy && setDropping(null)}>
                  Keep it
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => !busy && dropping !== "ask" && void drop(dropping)}
                  disabled={dropping === "ask"}
                  aria-disabled={busy || undefined}
                >
                  {asking === "drop" ? "Dropping…" : "Drop the plan"}
                </button>
              </span>
            </div>
          ) : (
            !editing && (
              <div className="pc-actions">
                {plan.state === "proposed" && (
                  <span className="pc-note">
                    {boss} answers routine questions and approvals for these sessions. Force-pushes, deletes outside the folder and sends to people come to you.
                  </span>
                )}
                {plan.state === "paused" && plan.paused && !resumable(plan.paused) && (
                  <span className="pc-note">
                    Paused: {pausedWhy(plan)}.{failing ? " Continue tries again." : " It goes on by itself once that's past."}
                  </span>
                )}
                <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => !busy && setDropping(sessionsRun ? "ask" : "stop")}>
                  Drop
                </button>
                {change && <span className="pc-note">Approve or turn down {boss}'s change first, then edit the plan.</span>}
                <button
                  type="button"
                  className="btn"
                  disabled={!!change}
                  aria-disabled={busy || undefined}
                  title={change ? `Approve or turn down ${boss}'s change first` : undefined}
                  onClick={() => !busy && setEditing(draft())}
                >
                  Edit
                </button>
                {plan.state === "running" && (
                  <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => !busy && void run("pause", () => store.pause(plan.id))}>
                    {asking === "pause" ? "Pausing…" : "Pause"}
                  </button>
                )}
                {plan.state === "paused" && resumable(plan.paused) && (
                  <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => !busy && void run("resume", () => store.resume(plan.id))}>
                    {asking === "resume" ? "Resuming…" : "Resume"}
                  </button>
                )}
                {failing && !waitsOnYou && (
                  <button type="button" className="btn btn-signal" aria-disabled={busy || undefined} onClick={() => !busy && goOn()}>
                    {asking === "continue" ? "Going on…" : "Continue"}
                  </button>
                )}
                {change && (
                  <button type="button" className="btn" aria-disabled={busy || stale || undefined} onClick={() => !busy && !stale && turnDown()}>
                    {asking === "turnDown" ? "Turning it down…" : "Turn down"}
                  </button>
                )}
                {waitsOnYou && plan.approvedRevision === null && (!plan.budget || plan.budget.unit === "usd") && (
                  <label className="pc-cap">
                    <span className="small muted">Cap it at $</span>
                    <input
                      aria-label="Cap the plan's spend, in dollars"
                      inputMode="decimal"
                      value={cap}
                      placeholder="none"
                      onChange={(e) => setCap(e.target.value)}
                    />
                    {cap.trim() !== "" && (
                      <>
                        <select className="pc-engine" aria-label="When it warns" value={warnAt} onChange={(e) => setWarnAt(Number(e.target.value))}>
                          {[...new Set([0.5, 0.8, 0.9, warnAt])]
                            .sort((a, b) => a - b)
                            .map((w) => (
                              <option key={w} value={w}>
                                warns at {Math.round(w * 100)}%
                              </option>
                            ))}
                        </select>
                        <select className="pc-engine" aria-label="When it's over" value={onExceed} onChange={(e) => setOnExceed(e.target.value as PlanBudget["onExceed"])}>
                          <option value="pause">pauses new starts when over</option>
                          <option value="warn">only tells you when over</option>
                        </select>
                      </>
                    )}
                  </label>
                )}
                {waitsOnYou && (
                  <button
                    type="button"
                    className="btn btn-signal"
                    aria-disabled={busy || stale || !!capProblem || undefined}
                    onClick={() => !busy && !stale && !capProblem && approve()}
                  >
                    {asking === "approve"
                      ? "Approving…"
                      : plan.approvedRevision !== null
                        ? "Approve the change"
                        : approvedCap
                          ? `Approve and run, capped at ${amountText(approvedCap.unit, approvedCap.amount)}`
                          : "Approve and run"}
                  </button>
                )}
                {capProblem && (
                  <span className="small state-blocked" role="alert">
                    {capProblem}
                  </span>
                )}
              </div>
            )
          )}
          <span className="sr-only" role="status">
            {asking ? BUSY[asking] : ""}
          </span>
          {problem && (
            <span className="small state-blocked" role="alert">
              {problem}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

/** Whether `e` shows enough of what it watches to count as seen: half of
 *  it, or (taller than the window) half the window's height of it. */
const inView = (e: IntersectionObserverEntry): boolean =>
  e.isIntersecting && (e.intersectionRatio >= 0.5 || (!!e.rootBounds && e.intersectionRect.height >= e.rootBounds.height / 2));

/** What the card says while the hub answers, for those who can't see the
 *  button's own word change. */
const BUSY: Record<Exclude<Asking, null>, string> = {
  approve: "Approving…",
  turnDown: "Turning the change down…",
  continue: "Going on…",
  pause: "Pausing…",
  resume: "Resuming…",
  drop: "Dropping…",
  save: "Saving…",
  engine: "Saving the engine…",
};

/** A change of scope in full: what approving it would approve. */
function ChangeDetails({ changes, names }: { changes: PlanChanges; names: ReadonlyMap<string, string> }) {
  const where = (t: { engine: Engine; folder: string }) => `${ENGINE_TITLE[t.engine]} in ${homeShort(t.folder)}`;
  const named = (ids: readonly string[]) => ids.map((id) => names.get(id) ?? "a ticket").join(", ");
  return (
    <ul className="pc-changes" aria-label="What approving it changes">
      {changes.goal && (
        <li>
          <span>
            Goal: “{changes.goal.from}” → “{changes.goal.to}”
          </span>
        </li>
      )}
      {changes.parallel && (
        <li>
          <span>
            At once: {changes.parallel.from ?? "the boss's limit"} → {changes.parallel.to ?? "the boss's limit"}
          </span>
        </li>
      )}
      {changes.budget && (
        <li>
          <span>
            Budget: {changes.budget.from ? budgetText(changes.budget.from) : "none of its own"} →{" "}
            {changes.budget.to ? budgetText(changes.budget.to) : "none of its own (the cap is taken off)"}
          </span>
        </li>
      )}
      {changes.order && (
        <li>
          <span>
            Order: {named(changes.order.from)} → {named(changes.order.to)}
          </span>
        </li>
      )}
      {changes.added.map((t) => (
        <li key={t.id}>
          <span>
            <b>Adds</b> {t.title} · <span className="mono">{where(t)}</span>
            {t.view && <span className="mono"> · {t.view} view</span>}
          </span>
          <span className="small">{t.needs.length > 0 ? `Starts after ${named(t.needs)}` : "Starts at once, alongside the others ready"}</span>
          {t.body.trim() && <span className="pc-body">{t.body}</span>}
        </li>
      ))}
      {changes.removed.map((t) => (
        <li key={t.id}>
          <span>
            <b>Drops</b> {t.title}
          </span>
        </li>
      ))}
      {changes.changed.map((c) => (
        <li key={c.ticket.id}>
          <span>
            <b>Changes</b> {c.title ? `“${c.title.from}” → “${c.title.to}”` : c.ticket.title}
          </span>
          {c.engine && (
            <span className="small">
              Engine: {ENGINE_TITLE[c.engine.from]} → {ENGINE_TITLE[c.engine.to]}
            </span>
          )}
          {c.folder && (
            <span className="small mono">
              Folder: {homeShort(c.folder.from)} → {homeShort(c.folder.to)}
            </span>
          )}
          {c.view && (
            <span className="small">
              View: {c.view.from ?? "the engine's own"} → {c.view.to ?? "the engine's own"}
            </span>
          )}
          {c.needs && (
            <span className="small">
              {[
                c.needs.added.length ? `Now waits for ${named(c.needs.added)}` : null,
                c.needs.dropped.length ? `no longer waits for ${named(c.needs.dropped)}, so it may start alongside it` : null,
              ]
                .filter(Boolean)
                .join("; ")}
            </span>
          )}
          {c.body && (
            <span className="pc-body">
              <span className="small muted">What it starts with now:</span> {c.body.to || "(nothing)"}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

const STATE_WORD: Partial<Record<BossPlanTicket["state"], { word: string; look: string }>> = {
  doing: { word: "Doing", look: "state-working" },
  review: { word: "In review", look: "state-working" },
  done: { word: "Done", look: "state-done" },
  dropped: { word: "Dropped", look: "faint" },
};

/** One ticket of a wave: its key and title, its engine (a picker while
 *  the plan waits to be approved and it hasn't started), its folder, what
 *  it needs, and where it stands. */
function TicketRow({
  t,
  all,
  own,
  choices,
  disabled,
  onEngine,
}: {
  t: BossPlanTicket;
  all: readonly BossPlanTicket[];
  own: boolean;
  choices: EngineChoice[] | null;
  disabled: boolean;
  onEngine: (e: Engine) => void;
}) {
  const needs = t.needs.map((n) => all.find((x) => x.id === n)?.key).filter(Boolean);
  const state = STATE_WORD[t.state];
  return (
    <div className="pc-tk">
      <span className="pc-key">{t.key ?? "·"}</span>
      <span className="pc-t">{t.title}</span>
      {choices && t.engine ? (
        <EngineSelect value={t.engine} choices={choices} label={`Engine for ${t.key ?? t.title}`} disabled={disabled} onChange={onEngine} />
      ) : (
        t.engine && <span className="chip">{ENGINE_TITLE[t.engine]}</span>
      )}
      <span className="pc-sub">
        {t.folder && <span className="mono">{homeShort(t.folder)}</span>}
        {needs.length > 0 && <span>· needs {needs.join(", ")}</span>}
        {own && <span>· own worktree</span>}
        {t.starting && <span className="state-working">· starting</span>}
        {t.held && <span className="state-blocked">· held: {t.held}</span>}
        {state && <span className={state.look}>· {state.word}</span>}
      </span>
      {t.body.trim() && (
        <details className="pc-tk-body">
          <summary className="small muted">What it starts with</summary>
          <span className="pc-body">{t.body}</span>
        </details>
      )}
    </div>
  );
}

/** The plan's tickets to change in place: each one's title, engine and
 *  needs; tickets added (with the folder they work in) and taken out. Saved
 *  as a new revision. */
function PlanEditor({
  draft,
  choices,
  lockedIds,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: DraftTicket[];
  choices: EngineChoice[];
  /** Tickets that have started: where they run stays. */
  lockedIds: ReadonlySet<string>;
  busy: boolean;
  onChange: (d: DraftTicket[]) => void;
  onCancel: () => void;
  onSave: (d: DraftTicket[]) => void;
}) {
  const put = (i: number, t: Partial<DraftTicket>) => onChange(draft.map((x, j) => (j === i ? { ...x, ...t } : x)));
  const firstEngine = draft.find((t) => t.engine)?.engine ?? "claude";
  const firstFolder = draft[draft.length - 1]?.folder ?? "";
  // A ticket added starts in the folder of the one before it.
  const [defaultFolder, setDefault] = useState("");
  const ok = draft.length > 0 && draft.every((t) => t.title.trim() && t.folder.trim());
  const label = (i: number) => `ticket ${i + 1}`;
  return (
    <form
      className="pc-edit"
      aria-label="Edit the plan"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSave(draft.map((t) => ({ ...t, title: t.title.trim(), folder: t.folder.trim() })));
      }}
    >
      <ol className="pc-edit-list">
        {draft.map((t, i) => {
          const locked = !!t.id && lockedIds.has(t.id);
          const may = needChoices(draft, i);
          return (
            <li key={t.id ?? `new-${i}`} className="pc-edit-row">
              <span className="pc-edit-line">
                <input className="pc-edit-title" aria-label={`Title of ${label(i)}`} value={t.title} onChange={(e) => put(i, { title: e.target.value })} required />
                <EngineSelect value={t.engine ?? firstEngine} choices={choices} label={`Engine of ${label(i)}`} disabled={locked} onChange={(engine) => put(i, { engine })} />
                <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${label(i)}`} onClick={() => onChange(withoutTicket(draft, i))}>
                  Remove
                </button>
              </span>
              {!t.id && (
                <>
                  <input className="pc-edit-folder mono" aria-label={`Folder of ${label(i)}`} value={t.folder} placeholder="/path/to/repo" onChange={(e) => put(i, { folder: e.target.value })} required />
                  {t.folder && t.folder === defaultFolder && (
                    <span className="pc-edit-default">The folder of the ticket above, as a start: change it if this one works elsewhere.</span>
                  )}
                </>
              )}
              {draft.length > 1 && (
                <span className="pc-edit-needs" role="group" aria-label={`What ${label(i)} needs first`}>
                  <span className="small muted">Needs</span>
                  {draft.map((other, j) =>
                    j === i ? null : (
                      <button
                        key={other.id ?? `new-${j}`}
                        type="button"
                        className="chip-btn"
                        aria-pressed={t.needs.includes(j)}
                        disabled={!t.needs.includes(j) && !may.includes(j)}
                        onClick={() => put(i, { needs: t.needs.includes(j) ? t.needs.filter((n) => n !== j) : [...t.needs, j] })}
                      >
                        {other.title.trim() || label(j)}
                      </button>
                    ),
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <span className="pc-actions">
        <button type="button" className="btn btn-ghost" onClick={() => {
            setDefault(firstFolder);
            onChange([...draft, { title: "", engine: firstEngine, folder: firstFolder, needs: [] }]);
          }}>
          Add a ticket
        </button>
        <span className="pc-note" />
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-signal" disabled={busy || !ok}>
          {busy ? "Saving…" : "Save"}
        </button>
      </span>
    </form>
  );
}
