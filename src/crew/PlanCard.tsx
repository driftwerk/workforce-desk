import { useEffect, useMemo, useState } from "react";
import { useBoard } from "../board/store";
import { ENGINE_TITLE } from "../engines/engines";
import { useDesk } from "../hub/store";
import type { BossPlan, BossPlanDetail, BossPlanTicket, DraftTicket, Engine, EngineInfo, OnPlanDrop } from "../hub/types";
import { useLocalAgent } from "../overview/people";
import { homeShort } from "../ui/paths";
import { plainError } from "../ui/plainError";
import {
  awaiting,
  draftOf,
  liveCard,
  liveTickets,
  needChoices,
  ownWorktrees,
  PAUSED_WHY,
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
          <span className="small faint">{supported === false ? "This computer's hub has no plans yet: update Desk to approve it here." : unread ? `Desk couldn't read this plan: ${unread}` : "Reading the plan…"}</span>
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

type Asking = null | "approve" | "pause" | "resume" | "drop" | "save" | "engine";

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

  const tickets = useMemo(() => liveTickets(detail, board), [detail, board]);
  const rules = useMemo(() => tickets.map(ruled), [tickets]);
  const byId = useMemo(() => new Map(rules.map((t) => [t.id, t] as const)), [rules]);
  const shownWaves = useMemo(() => waves(rules), [rules]);
  const own = useMemo(() => ownWorktrees(shownWaves, byId), [shownWaves, byId]);
  const now = useMemo(() => progress(rules), [rules]);
  const stand = standing(plan);
  const waitsOnYou = awaiting(plan);
  const change = waitsOnYou && plan.approvedRevision !== null ? revisionOf(detail, plan.revision) : undefined;
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
  const approve = () => void run("approve", () => store.approve(plan.id, detail.revision));
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
          <span className={`chip pc-chip-${stand.look}`}>{plan.state === "paused" && plan.paused ? `Paused: ${PAUSED_WHY[plan.paused]}` : stand.text}</span>
          <span className="chip">rev {plan.revision}</span>
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
        <div className="pc-change" role="group" aria-label="A change to the plan">
          <span>
            <b>{boss}</b> wants to change the plan: {change.summary}
          </span>
          <span className="small muted">
            A change of scope, so it needs you. The plan keeps running on revision {plan.approvedRevision} meanwhile.
          </span>
        </div>
      )}

      {(plan.state === "running" || plan.state === "paused" || plan.state === "done") && (
        <div className="pc-progress">
          <span className="muted small">
            {progressLine(now)}
            {plan.state === "paused" && plan.paused && <span className="pc-paused"> · new starts paused: {PAUSED_WHY[plan.paused]}</span>}
          </span>
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
          pending={change ? `Saving includes ${boss}'s proposed change (${change.summary}) and applies it now.` : null}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={(t) => void save(t)}
        />
      ) : (
        shownWaves.map((wave, i) => {
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
        })
      )}

      {!ended && (
        <div className="pc-foot">
          <div className="pc-facts">
            <span className="chip">
              {now.total} ticket{now.total === 1 ? "" : "s"}
            </span>
            {plan.parallel !== null && <span className="chip">up to {plan.parallel} at once</span>}
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
                <button type="button" className="btn" onClick={() => setDropping(null)} disabled={busy}>
                  Keep it
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => dropping !== "ask" && void drop(dropping)}
                  disabled={busy || dropping === "ask"}
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
                {plan.state === "paused" && plan.paused && !resumable(plan.paused) && <span className="pc-note">Paused: {PAUSED_WHY[plan.paused]}. It goes on by itself once that's past.</span>}
                <button type="button" className="btn" disabled={busy} onClick={() => setDropping(sessionsRun ? "ask" : "stop")}>
                  Drop
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => setEditing(draft())}>
                  Edit
                </button>
                {plan.state === "running" && (
                  <button type="button" className="btn" disabled={busy} onClick={() => void run("pause", () => store.pause(plan.id))}>
                    {asking === "pause" ? "Pausing…" : "Pause"}
                  </button>
                )}
                {plan.state === "paused" && resumable(plan.paused) && (
                  <button type="button" className="btn" disabled={busy} onClick={() => void run("resume", () => store.resume(plan.id))}>
                    {asking === "resume" ? "Resuming…" : "Resume"}
                  </button>
                )}
                {waitsOnYou && (
                  <button type="button" className="btn btn-signal" disabled={busy} onClick={approve}>
                    {asking === "approve" ? "Approving…" : plan.approvedRevision === null ? "Approve and run" : "Approve the change"}
                  </button>
                )}
              </div>
            )
          )}
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
        {state && <span className={state.look}>· {state.word}</span>}
      </span>
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
  pending,
  onChange,
  onCancel,
  onSave,
}: {
  draft: DraftTicket[];
  /** A change of scope the boss proposed, which saving the edit takes in. */
  pending: string | null;
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
                <input className="pc-edit-folder mono" aria-label={`Folder of ${label(i)}`} value={t.folder} placeholder="/path/to/repo" onChange={(e) => put(i, { folder: e.target.value })} required />
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
        <button type="button" className="btn btn-ghost" onClick={() => onChange([...draft, { title: "", engine: firstEngine, folder: firstFolder, needs: [] }])}>
          Add a ticket
        </button>
        <span className="pc-note">{pending}</span>
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
