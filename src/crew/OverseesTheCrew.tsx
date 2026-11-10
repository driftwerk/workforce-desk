import { useEffect, useId, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { useDesk } from "../hub/store";
import type { OversightLevel } from "../hub/types";
import { useOverview } from "../overview/store";
import { CloseButton, Dialog, radioKeys } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { useAgentConfigs } from "./agentBrain";
import { useLayout } from "../groups/store";
import { useHubLayout } from "../groups/hubLayout";
import { askMove } from "../groups/move";
import { startable } from "../engines/engines";
import type { EngineInfo } from "../hub/types";
import {
  MAX_CHECKINS_PER_HOUR,
  MAX_WORK_TURNS_PER_HOUR,
  fullMissing,
  isUnbound,
  oversightOf,
  parseBudget,
  parseCheckins,
  parseHold,
  parseParallel,
  parseMinutes,
  parseRepo,
  parseTime,
  parseWorkflow,
  readable,
  setAgentOversight,
  type Oversight,
  type TakeOn,
} from "./oversight";
import { ENGINE_TITLE } from "../engines/engines";

/** Which sessions it takes on, as the person picks it. */
const TAKE_ON = (name: string): { id: TakeOn; name: string; desc: string }[] => [
  { id: "handed", name: "Only what I hand it", desc: `Sessions ${name} starts, and ones you hand it with Hand to ${name}.` },
  { id: "all", name: "Every session it can", desc: `Each session on Desk’s line, as it starts. One you release stays yours.` },
];

const LEVELS: { id: OversightLevel; name: string; desc: string }[] = [
  { id: "watch", name: "Watch", desc: "Answers “what’s everyone doing?” and tells you when something needs you." },
  { id: "suggest", name: "Suggest", desc: "Also proposes what to do. Nothing happens until you say yes." },
  { id: "act", name: "Act", desc: "Handles the routine itself, within the rules below, and tells you what it did." },
  { id: "full", name: "Act fully", desc: "Merges, tags, releases and runs your named workflows in the repos you name, under a daily budget." },
];

/** What always stays with you, at every level, Act fully included: the
 *  hub's never-list, by heading. */
const ALWAYS_YOURS = [
  "Reading or exporting secrets and credentials",
  "Publishing to a package registry",
  "Force-pushing or rewriting history",
  "Deleting branches, tags or releases on the remote",
  "Deleting anything outside the session’s folder",
  "Changing its own settings, level or budget",
  "Spending or moving money",
  "New ways out, sign-ins, and sessions that don’t ask",
];

type Change = (o: Oversight) => Oversight;

/** What's typed in a field, and the problem with it if it can't be used. */
interface Typed {
  text: string;
  problem: string | null;
}

const typed = (text: string): Typed => ({ text, problem: null });

/** What an off minutes field turns back on with: the last minutes it had
 *  when they can be used, else `fallback`. */
const lastMinutes = (was: Typed | undefined, fallback: string): string =>
  was && "value" in parseMinutes(was.text) ? was.text.trim() : fallback;

/** The text fields as the config says them; an off one shows what it would
 *  be when turned back on. (Minutes of 0 are off: the hub doesn't speak up
 *  for that.) */
const fieldsOf = (o: Oversight, was?: Record<Field, Typed>): Record<Field, Typed> => ({
  waiting: typed(o.wake.waitingMinutes ? String(o.wake.waitingMinutes) : lastMinutes(was?.waiting, "5")),
  quiet: typed(o.wake.quietMinutes ? String(o.wake.quietMinutes) : lastMinutes(was?.quiet, "30")),
  morning: typed(o.summaries.morning || (was?.morning.text ?? "09:00")),
  evening: typed(o.summaries.evening || (was?.evening.text ?? "18:00")),
  hourly: typed(String(o.maxCheckinsPerHour)),
  checkins: typed(String(o.maxCheckinsPerDay)),
  parallel: typed(String(o.work.parallel)),
  turns: typed(String(o.work.maxTurnsPerHour)),
  hold: typed(String(o.wake.holdMinutes)),
  budget: typed(o.full.budgetUsdPerDay === null ? (was?.budget.text ?? "") : String(o.full.budgetUsdPerDay)),
  repo: was?.repo ?? typed(""),
  workflow: was?.workflow ?? typed(""),
});

type Field =
  | "waiting"
  | "quiet"
  | "morning"
  | "evening"
  | "hourly"
  | "checkins"
  | "parallel"
  | "turns"
  | "hold"
  | "budget"
  | "repo"
  | "workflow";

/** An agent's Settings section for overseeing the crew: on or off (one
 *  agent at a time), how much it does on its own, what it keeps track of,
 *  when it speaks up, and what it may do without asking. Written to the
 *  `[oversight]` of its config. */
export function OverseesTheCrew({ agent }: { agent: Agent }) {
  const desk = useDesk((s) => s.hub);
  const key = agentKey(agent);
  const config = useAgentConfigs((s) => s.configs[key]);
  const put = useAgentConfigs((s) => s.put);
  const manager = useOverview((s) => s.manager);
  const support = useOverview((s) => s.managerSupport);
  const roster = useChat((s) => s.roster);
  const { groups } = useLayout();
  const movable = useHubLayout((s) => s.layout !== null);
  const hubs = useChat((s) => s.hubs);
  const [o, setO] = useState<Oversight | null>(null);
  const [fields, setFields] = useState<Record<Field, Typed> | null>(null);
  const [status, setStatus] = useState<{ state: "idle" | "saving" | "saved" } | { state: "failed"; problem: string }>({ state: "idle" });
  const [confirming, setConfirming] = useState(false);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const saving = useRef(0);
  const ids = useId();

  useEffect(() => {
    if (desk && config === undefined) void useAgentConfigs.getState().load(desk, agent);
  }, [desk, config, agent]);
  useEffect(() => {
    if (support === "unknown") void useOverview.getState().loadManager();
  }, [support]);
  // The file as last read or written, unless a change of ours is on its way.
  useEffect(() => {
    if (config === undefined || saving.current > 0) return;
    const next = oversightOf(config);
    setO(next);
    setFields((was) => fieldsOf(next, was ?? undefined));
  }, [config]);

  if (support === "no") return null;
  const name = agent.name;
  const head = `${ids}-head`;
  const otherId = manager?.agentId && manager.agentId !== agent.id ? manager.agentId : null;
  const other = otherId
    ? (roster.find((a) => a.id === otherId && hubs.find((h) => h.id === a.hubId)?.local)?.name ?? otherId)
    : null;
  const usable = config !== undefined && readable(config);
  // The sidebar group it sits in, whose boss it may have been.
  const sitsIn = groups.find((g) => g.items.includes(`agent:${agentKey(agent)}`))?.name ?? null;
  // A group's boss oversees only that group.
  const bossOf = o?.group ? (groups.find((g) => g.id === o.group)?.name ?? null) : null;

  const update = (change: Change) => {
    if (!desk || !o) return;
    setO(change(o));
    setStatus({ state: "saving" });
    saving.current += 1;
    const write = writes.current.then(() => setAgentOversight(desk, agent.id, change));
    writes.current = write.catch(() => {});
    write.then(
      (toml) => {
        saving.current -= 1;
        put(key, toml);
        setStatus({ state: "saved" });
        const s = useOverview.getState();
        void s.loadManager();
        if (s.overviewSupport === "yes") void s.loadOverview();
      },
      (e: unknown) => {
        saving.current -= 1;
        setStatus({ state: "failed", problem: plainError(e) });
        // Back to what the file says.
        if (config !== undefined) setO(oversightOf(useAgentConfigs.getState().configs[key] ?? config));
      },
    );
  };

  const setField = (f: Field, text: string) => setFields((x) => x && { ...x, [f]: { text, problem: null } });
  /** Saves a field once what's typed can be used; says why not otherwise. */
  const commit = (f: Field, apply: (o: Oversight, text: string) => Oversight | string) => {
    if (!o || !fields) return;
    const result = apply(o, fields[f].text);
    if (typeof result === "string") return setFields({ ...fields, [f]: { ...fields[f], problem: result } });
    if (JSON.stringify(result) !== JSON.stringify(o)) update(() => result);
  };
  const minutes = (pick: (o: Oversight, v: number) => Oversight) => (o: Oversight, text: string) => {
    const r = parseMinutes(text);
    return "problem" in r ? r.problem : pick(o, r.value);
  };
  const time = (pick: (o: Oversight, v: string) => Oversight) => (o: Oversight, text: string) => {
    const r = parseTime(text);
    return "problem" in r ? r.problem : pick(o, r.value);
  };
  const setWaiting = minutes((o, v) => ({ ...o, wake: { ...o.wake, waitingMinutes: v } }));
  const setQuiet = minutes((o, v) => ({ ...o, wake: { ...o.wake, quietMinutes: v } }));
  const setMorning = time((o, v) => ({ ...o, summaries: { ...o.summaries, morning: v } }));
  const setEvening = time((o, v) => ({ ...o, summaries: { ...o.summaries, evening: v } }));
  const setHourly = (o: Oversight, text: string) => {
    const r = parseCheckins(text, MAX_CHECKINS_PER_HOUR);
    return "problem" in r ? r.problem : { ...o, maxCheckinsPerHour: r.value };
  };
  const setCheckins = (o: Oversight, text: string) => {
    const r = parseCheckins(text);
    return "problem" in r ? r.problem : { ...o, maxCheckinsPerDay: r.value };
  };
  const setParallel = (o: Oversight, text: string) => {
    const r = parseParallel(text);
    return "problem" in r ? r.problem : { ...o, work: { ...o.work, parallel: r.value } };
  };
  const setTurns = (o: Oversight, text: string) => {
    const r = parseCheckins(text, MAX_WORK_TURNS_PER_HOUR);
    return "problem" in r ? r.problem : { ...o, work: { ...o.work, maxTurnsPerHour: r.value } };
  };
  const setHold = (o: Oversight, text: string) => {
    const r = parseHold(text);
    return "problem" in r ? r.problem : { ...o, wake: { ...o.wake, holdMinutes: r.value } };
  };
  const setBudget = (o: Oversight, text: string) => {
    const r = parseBudget(text);
    return "problem" in r ? r.problem : { ...o, full: { ...o.full, budgetUsdPerDay: r.value } };
  };
  /** Adds what's typed to a list once it can be used; the field empties. */
  const add = (f: "repo" | "workflow") => {
    if (!o || !fields) return;
    const list = f === "repo" ? o.full.repos : o.full.workflows;
    const r = f === "repo" ? parseRepo(fields[f].text, list) : parseWorkflow(fields[f].text, list);
    if ("problem" in r) return setFields({ ...fields, [f]: { ...fields[f], problem: r.problem } });
    setFields({ ...fields, [f]: typed("") });
    update((x) => ({ ...x, full: { ...x.full, [f === "repo" ? "repos" : "workflows"]: [...list, r.value] } }));
  };
  const remove = (f: "repos" | "workflows", item: string) =>
    update((x) => ({ ...x, full: { ...x.full, [f]: x.full[f].filter((i) => i !== item) } }));
  /** Turning a row with a field on uses what's typed in it, if it can. */
  const turnOn = (f: Field, apply: (o: Oversight, text: string) => Oversight | string, off: Change) => (on: boolean) => {
    if (!o || !fields) return;
    if (!on) return update(off);
    const result = apply(o, fields[f].text);
    if (typeof result === "string") return setFields({ ...fields, [f]: { ...fields[f], problem: result } });
    update(() => result);
  };

  const enable = (on: boolean) => {
    // Taking over from the main overseer, or a group's boss becoming the
    // main one, asks first.
    if (on && (other || o?.group)) return setConfirming(true);
    // This switch is the main overseer's: on or off it names no group, so
    // a group it oversaw opens to the main overseer (a group any config
    // names stays apart from everyone).
    update((x) => ({ ...x, enabled: on, group: null }));
  };

  const current = o ? LEVELS.findIndex((l) => l.id === o.level) : -1;
  // The level the hub runs it at now: Act until Act fully is in force.
  const running =
    manager?.agentId === agent.id ? manager.level : (manager?.bosses?.find((b) => b.agentId === agent.id)?.level ?? null);
  const missing = o ? fullMissing(o) : [];
  const unbound = o ? isUnbound(o) : false;
  const acts = o?.level === "act" || o?.level === "full";
  const takeOn = TAKE_ON(name);
  const takeOnAt = o ? takeOn.findIndex((t) => t.id === o.work.takeOn) : -1;

  return (
    <section className="agent-section oversee" aria-labelledby={head}>
      <div className="oversee-top">
        <span className="oversee-intro">
          <h2 id={head}>Oversees the crew</h2>
          <span className="oversee-sub">
            {name} keeps track of every agent and session and tells you what needs you. Only one crew member oversees at a time.
          </span>
          {o && !o.enabled && other && <span className="oversee-sub">{other} oversees the crew now.</span>}
          {o?.enabled && bossOf && (
            <span className="oversee-sub">
              Oversees only {bossOf}: its sessions and agents.{" "}
              {movable && o.group && (
                <button type="button" className="link" onClick={() => askMove({ kind: "boss", id: agent.id, name, from: o.group! })}>
                  Move {name} to another group…
                </button>
              )}
            </span>
          )}
        </span>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={o?.enabled ?? false}
          aria-labelledby={head}
          disabled={!o || !usable}
          onClick={() => o && enable(!o.enabled)}
        >
          <span className="switch-knob" />
        </button>
      </div>
      {config !== undefined && !usable && (
        <p className="small state-blocked">Their settings file has a mistake in it, so Desk won’t change it.</p>
      )}
      {status.state !== "idle" && (
        <p className={`small ${status.state === "failed" ? "state-blocked" : status.state === "saved" ? "state-done" : "faint"}`} role="status">
          {status.state === "failed" ? status.problem : status.state === "saving" ? "Saving…" : "Saved."}
        </p>
      )}

      {o?.enabled && fields && (
        <>
          <div className="oversee-part">
            <h3>How much {name} does on its own</h3>
            <div className="oversee-levels oversee-levels-4" role="radiogroup" aria-label="How much it does on its own">
              {LEVELS.map((l, i) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  className="oversee-level"
                  aria-checked={o.level === l.id}
                  tabIndex={i === current ? 0 : -1}
                  onClick={() => o.level !== l.id && update((x) => ({ ...x, level: l.id }))}
                  onKeyDown={(e) => radioKeys(e, LEVELS, current, (next) => next.id !== o.level && update((x) => ({ ...x, level: next.id })))}
                >
                  <b>{l.name}</b>
                  <span>{l.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="oversee-part">
            <h3>What {name} keeps track of</h3>
            <div className="oversee-card">
              <Check
                label="Crew on this computer"
                sub="What each is working on, questions to you, finished work"
                checked={o.track.crew}
                onChange={(v) => update((x) => ({ ...x, track: { ...x.track, crew: v } }))}
              />
              <Check
                label="Sessions started in Desk"
                sub={`Claude Code and Codex: state, the tool running, approvals, replies. ${name} can act on these.`}
                checked={o.track.deskSessions}
                onChange={(v) => update((x) => ({ ...x, track: { ...x.track, deskSessions: v } }))}
              />
              <Check
                label="Sessions in other terminals"
                sub={`Whether they’re working or waiting, and where. ${name} can resume them once they end.`}
                checked={o.track.externalSessions}
                onChange={(v) => update((x) => ({ ...x, track: { ...x.track, externalSessions: v } }))}
              />
              <Check
                label="Crew in your workspaces"
                sub={workspacesLine(hubs.filter((h) => !h.local && !h.machine).map((h) => h.label))}
                checked={o.track.workspaces}
                onChange={(v) => update((x) => ({ ...x, track: { ...x.track, workspaces: v } }))}
              />
            </div>
          </div>

          <div className="oversee-part">
            <h3>When {name} speaks up</h3>
            <div className="oversee-card">
              <Check
                label="Something has waited on you for"
                checked={o.wake.waitingMinutes > 0}
                onChange={turnOn("waiting", setWaiting, (x) => ({ ...x, wake: { ...x.wake, waitingMinutes: 0 } }))}
                problem={{ id: `${ids}-waiting`, text: fields.waiting.problem }}
              >
                <Num
                  problemId={`${ids}-waiting`}
                  label="Minutes waiting"
                  value={fields.waiting}
                  disabled={o.wake.waitingMinutes === 0}
                  onChange={(t) => setField("waiting", t)}
                  onCommit={() => commit("waiting", setWaiting)}
                  unit="min"
                />
              </Check>
              <Check
                label="Work has gone quiet while working for"
                checked={o.wake.quietMinutes > 0}
                onChange={turnOn("quiet", setQuiet, (x) => ({ ...x, wake: { ...x.wake, quietMinutes: 0 } }))}
                problem={{ id: `${ids}-quiet`, text: fields.quiet.problem }}
              >
                <Num
                  problemId={`${ids}-quiet`}
                  label="Minutes quiet"
                  value={fields.quiet}
                  disabled={o.wake.quietMinutes === 0}
                  onChange={(t) => setField("quiet", t)}
                  onCommit={() => commit("quiet", setQuiet)}
                  unit="min"
                />
              </Check>
              <Check
                label="A session or task finishes"
                checked={o.wake.onFinish}
                onChange={(v) => update((x) => ({ ...x, wake: { ...x.wake, onFinish: v } }))}
              />
              <Check
                label="Something fails or hits a usage limit"
                checked={o.wake.onFailure}
                onChange={(v) => update((x) => ({ ...x, wake: { ...x.wake, onFailure: v } }))}
              />
              <Check
                label="A session asks it something"
                sub="Off, sessions’ questions come straight to you"
                checked={o.wake.onMessage}
                onChange={(v) => update((x) => ({ ...x, wake: { ...x.wake, onMessage: v } }))}
              />
              <div className="oversee-row">
                <span className="oversee-check">
                  <span className="oversee-check-text">
                    <b>Hold for you after you type</b>
                    <span className="oversee-sub">A session {name} runs stays yours this long after your last keystroke or message in it</span>
                  </span>
                </span>
                <Num
                  problemId={`${ids}-hold`}
                  label="Hold minutes"
                  value={fields.hold}
                  onChange={(t) => setField("hold", t)}
                  onCommit={() => commit("hold", setHold)}
                  unit="min"
                />
                {fields.hold.problem && <Problem id={`${ids}-hold`} text={fields.hold.problem} />}
              </div>
              <Check
                label="Morning summary at"
                checked={o.summaries.morning !== ""}
                onChange={turnOn("morning", setMorning, (x) => ({ ...x, summaries: { ...x.summaries, morning: "" } }))}
                problem={{ id: `${ids}-morning`, text: fields.morning.problem }}
              >
                <Num
                  problemId={`${ids}-morning`}
                  label="Morning summary time"
                  value={fields.morning}
                  disabled={o.summaries.morning === ""}
                  onChange={(t) => setField("morning", t)}
                  onCommit={() => commit("morning", setMorning)}
                  time
                />
              </Check>
              <Check
                label="End-of-day summary at"
                checked={o.summaries.evening !== ""}
                onChange={turnOn("evening", setEvening, (x) => ({ ...x, summaries: { ...x.summaries, evening: "" } }))}
                problem={{ id: `${ids}-evening`, text: fields.evening.problem }}
              >
                <Num
                  problemId={`${ids}-evening`}
                  label="End-of-day summary time"
                  value={fields.evening}
                  disabled={o.summaries.evening === ""}
                  onChange={(t) => setField("evening", t)}
                  onCommit={() => commit("evening", setEvening)}
                  time
                />
              </Check>
            </div>
            <span className="oversee-sub oversee-cap">
              {name} checks in at most{" "}
              <Num
                problemId={`${ids}-hourly`}
                label="Check-ins an hour"
                value={fields.hourly}
                onChange={(t) => setField("hourly", t)}
                onCommit={() => commit("hourly", setHourly)}
                narrow
              />{" "}
              times an hour and{" "}
              <Num
                problemId={`${ids}-checkins`}
                label="Check-ins a day"
                value={fields.checkins}
                onChange={(t) => setField("checkins", t)}
                onCommit={() => commit("checkins", setCheckins)}
                narrow
              />{" "}
              times a day. Events close together are taken as one, and what happens past those waits for the next.
            </span>
            {fields.hourly.problem && <Problem id={`${ids}-hourly`} text={fields.hourly.problem} />}
            {fields.checkins.problem && <Problem id={`${ids}-checkins`} text={fields.checkins.problem} />}
          </div>

          <div className="oversee-part">
            <h3>How {name} works</h3>
            <span className="oversee-sub">
              {o.level === "watch"
                ? `At Watch, ${name} runs no sessions. Set it to Suggest or Act to hand it work.`
                : o.level === "suggest"
                  ? `At Suggest, each session ${name} would start or answer for comes to you to say yes to first.`
                  : `${name} runs the sessions it takes on with you: it hears when each turn ends, tells it the next step and answers what it can. Type in one and you’re driving for ${o.wake.holdMinutes === 1 ? "a minute" : `${o.wake.holdMinutes} minutes`} after your last keystroke.`}
            </span>
            <div className="oversee-card">
              <Check
                label="Always work in real sessions"
                sub={`${name} does all coding in sessions you can watch, type into and take over: no edits to code, builds or shell commands of its own. It still reads, searches and keeps its own notes, and helpers only look things up. Workflow coding steps and pilot rounds still run as before`}
                checked={o.work.preferSessions}
                onChange={(v) => update((x) => ({ ...x, work: { ...x.work, preferSessions: v } }))}
              />
              <div className="oversee-row">
                <label className="oversee-check" htmlFor={`${ids}-engine`}>
                  <span className="oversee-check-text">
                    <b>New sessions run</b>
                    <span className="oversee-sub">Unless {name} picks another for a piece of work</span>
                  </span>
                </label>
                <EngineSelect id={`${ids}-engine`} value={o.work.engine} onChange={(engine) => update((x) => ({ ...x, work: { ...x.work, engine } }))} />
              </div>
            </div>
            <div className="oversee-levels oversee-levels-2" role="radiogroup" aria-label="Which sessions it takes on">
              {takeOn.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  className="oversee-level"
                  aria-checked={o.work.takeOn === t.id}
                  tabIndex={i === takeOnAt ? 0 : -1}
                  onClick={() => o.work.takeOn !== t.id && update((x) => ({ ...x, work: { ...x.work, takeOn: t.id } }))}
                  onKeyDown={(e) =>
                    radioKeys(e, takeOn, takeOnAt, (next) => next.id !== o.work.takeOn && update((x) => ({ ...x, work: { ...x.work, takeOn: next.id } })))
                  }
                >
                  <b>{t.name}</b>
                  <span>{t.desc}</span>
                </button>
              ))}
            </div>
            <span className="oversee-sub oversee-cap">
              {name} runs at most{" "}
              <Num
                problemId={`${ids}-parallel`}
                label="Sessions at once"
                value={fields.parallel}
                onChange={(t) => setField("parallel", t)}
                onCommit={() => commit("parallel", setParallel)}
                narrow
              />{" "}
              sessions at once and spends at most{" "}
              <Num
                problemId={`${ids}-turns`}
                label="Work turns an hour"
                value={fields.turns}
                onChange={(t) => setField("turns", t)}
                onCommit={() => commit("turns", setTurns)}
                narrow
              />{" "}
              turns an hour on their turn ends. Taking on a session you hand it is never refused for the limit.
            </span>
            {fields.parallel.problem && <Problem id={`${ids}-parallel`} text={fields.parallel.problem} />}
            {fields.turns.problem && <Problem id={`${ids}-turns`} text={fields.turns.problem} />}
          </div>

          {o.level === "full" && (
            <div className="oversee-part">
              <h3>Where {name} acts fully</h3>
              {missing.length > 0 ? (
                <p className="small state-blocked" role="status">
                  Acting as Act until repos and a budget are set.
                </p>
              ) : (
                running === "act" && (
                  <p className="small state-blocked" role="status">
                    Acting as Act for now: the hub says Act fully isn’t in force. Today’s spend has reached the daily budget, or
                    hasn’t been read yet.
                  </p>
                )
              )}
              <div className="oversee-card">
                <Check
                  label="Anywhere"
                  sub="Not limited to the repos, folders and workflows listed"
                  checked={o.full.anywhere}
                  onChange={(v) => update((x) => ({ ...x, full: { ...x.full, anywhere: v } }))}
                />
                {o.full.anywhere && (
                  <div className="oversee-row">
                    <span className="oversee-sub" role="note">
                      The repos and workflows below don’t apply while Anywhere is on.
                    </span>
                  </div>
                )}
                <div className="oversee-row oversee-list">
                  <span className="oversee-check-text">
                    <b>Repos</b>
                    <span className="oversee-sub">owner/name on GitHub, a repo’s address, or a folder on this computer</span>
                  </span>
                  {o.full.repos.length > 0 && (
                    <ul className="oversee-items" aria-label="Repos" aria-disabled={o.full.anywhere || undefined}>
                      {o.full.repos.map((r) => (
                        <li key={r}>
                          <span className="mono">{r}</span>
                          <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${r}`} disabled={o.full.anywhere} onClick={() => remove("repos", r)}>
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <AddItem
                    label="Add a repo"
                    placeholder="acme/acme-web"
                    problemId={`${ids}-repo`}
                    value={fields.repo}
                    onChange={(t) => setField("repo", t)}
                    onAdd={() => add("repo")}
                    disabled={o.full.anywhere}
                  />
                </div>
                <div className="oversee-row">
                  <span className="oversee-check">
                    <span className="oversee-check-text">
                      <b>Daily budget</b>
                      <span className="oversee-sub">
                        {o.full.anywhere ? "Optional (blank: no budget)" : "Required"}. Its sessions’ spend in its scope and its own model use, in a day
                      </span>
                    </span>
                  </span>
                  <Num
                    problemId={`${ids}-budget`}
                    label="Daily budget in US dollars"
                    value={fields.budget}
                    onChange={(t) => setField("budget", t)}
                    onCommit={() => commit("budget", setBudget)}
                    unit="USD a day"
                  />
                  {fields.budget.problem && <Problem id={`${ids}-budget`} text={fields.budget.problem} />}
                </div>
                <div className="oversee-row oversee-list">
                  <span className="oversee-check-text">
                    <b>Workflows</b>
                    <span className="oversee-sub">
                      Deploys and promotions run only through these GitHub workflows, by file name, on the default branch
                    </span>
                  </span>
                  {o.full.workflows.length > 0 && (
                    <ul className="oversee-items" aria-label="Workflows" aria-disabled={o.full.anywhere || undefined}>
                      {o.full.workflows.map((w) => (
                        <li key={w}>
                          <span className="mono">{w}</span>
                          <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${w}`} disabled={o.full.anywhere} onClick={() => remove("workflows", w)}>
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <AddItem
                    label="Add a workflow"
                    placeholder="deploy.yml"
                    problemId={`${ids}-workflow`}
                    value={fields.workflow}
                    onChange={(t) => setField("workflow", t)}
                    onAdd={() => add("workflow")}
                    disabled={o.full.anywhere}
                  />
                </div>
              </div>
              <span className="oversee-sub">
                In those repos {name} may merge pull requests, push the default branch when it sends nothing new, tag and release
                the default branch as GitHub has it, and run the workflows above. Deploy tools and release scripts stay yours.
              </span>
              <div className="oversee-never">
                <b>Always yours, at every level</b>
                <ul>
                  {ALWAYS_YOURS.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {acts && (
            <div className="oversee-part">
              <h3>What {name} may do without asking</h3>
              <div className="oversee-card">
                <Check
                  label="Nudge"
                  sub="Ask a quiet agent or session how it’s getting on"
                  checked={o.act.nudge}
                  onChange={(v) => update((x) => ({ ...x, act: { ...x.act, nudge: v } }))}
                />
                <Check
                  label="Resume and restart"
                  sub="Pick up sessions stopped by a limit; restart ones that are stuck"
                  checked={o.act.resumeRestart}
                  onChange={(v) => update((x) => ({ ...x, act: { ...x.act, resumeRestart: v } }))}
                />
                <Check
                  label="Allow read-only requests"
                  sub="Approve tools that only read, inside the session’s own folder"
                  checked={o.act.readOnlyApprovals}
                  onChange={(v) => update((x) => ({ ...x, act: { ...x.act, readOnlyApprovals: v } }))}
                />
                <Check
                  label="Hand out work"
                  sub="Start sessions for the crew"
                  checked={o.act.handOutWork}
                  onChange={(v) => update((x) => ({ ...x, act: { ...x.act, handOutWork: v } }))}
                />
                <Check
                  label="Interrupt"
                  sub="End a session’s turn when it’s stuck, as Esc in its terminal; the session and its terminal keep running"
                  checked={o.act.interrupt}
                  onChange={(v) => update((x) => ({ ...x, act: { ...x.act, interrupt: v } }))}
                />
                <Check
                  label="Message agents"
                  sub="Nudge agents and hand them tasks without asking. Agents still need you to post or send anything outside Desk, delete anything or change what they remember; their other tools run under their own permissions"
                  checked={o.act.messageAgents}
                  onChange={(v) => update((x) => ({ ...x, act: { ...x.act, messageAgents: v } }))}
                />
                <Check
                  label="Answer sessions’ questions"
                  sub="Answer what sessions ask it on their line. Questions about pushing, deleting, deploying or sending come to you, with its draft"
                  checked={o.act.answerSessions}
                  onChange={(v) => update((x) => ({ ...x, act: { ...x.act, answerSessions: v } }))}
                />
                <Check
                  label="Message sessions from other terminals"
                  sub="Nudge sessions started outside Desk without asking. They may have been started not to ask before they act"
                  checked={o.act.messageTerminalSessions}
                  onChange={(v) => update((x) => ({ ...x, act: { ...x.act, messageTerminalSessions: v } }))}
                />
                <Check
                  label="Change sessions’ permission mode"
                  sub="Switch a running session between default, accept edits and plan; never to a mode that skips asking"
                  checked={o.act.setMode}
                  onChange={(v) => update((x) => ({ ...x, act: { ...x.act, setMode: v } }))}
                />
              </div>
              {unbound && (
                <p className="small state-blocked" role="status">
                  No limits: Desk acts on everything itself, including publishing, deploys and secrets. Only your budget, Stop and the
                  activity log remain.
                </p>
              )}
              <span className="oversee-sub">
                {name} always asks you first before pushing code, deleting anything, or sending messages outside Desk. Everything it
                does shows in Activity with its reason.
              </span>
            </div>
          )}
        </>
      )}

      {confirming && (other || o?.group) && (
        <Dialog
          onClose={() => setConfirming(false)}
          title={(id) => (
            <header className="dialog-head">
              <span className="dialog-title">
                <h1 id={id} className="display-md">
                  Make {name} the {o?.group ? "main boss" : "overseer"}?
                </h1>
                {other && (
                  <p>
                    {other} oversees the crew now — make {name} the overseer instead? {other} stops overseeing; nothing else about{" "}
                    {other} changes.
                  </p>
                )}
                {o?.group ? (
                  <p>
                    {name} stops overseeing only {bossOf ?? "its group"}: everything no boss of its own oversees is {name}’s from now on,{" "}
                    {bossOf ?? "that group"} included. What {name} learned in {bossOf ?? "that group"} stays there: it won’t recall it as the main
                    boss.
                  </p>
                ) : (
                  sitsIn && <p>What {name} learned about {sitsIn} stays with it.</p>
                )}
              </span>
              <CloseButton onClose={() => setConfirming(false)} />
            </header>
          )}
        >
          <footer className="dialog-foot">
            <span className="dialog-foot-note" />
            <button type="button" className="btn btn-ghost" data-autofocus onClick={() => setConfirming(false)}>
              {other ? `Keep ${other}` : "Cancel"}
            </button>
            <button
              type="button"
              className="btn btn-signal"
              onClick={() => {
                setConfirming(false);
                update((x) => ({ ...x, enabled: true, group: null }));
              }}
            >
              Make {name} the {o?.group ? "main boss" : "overseer"}
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}

/** The engine new sessions run on: one this computer can start that has
 *  Desk's line, or the one the config names. */
function EngineSelect({ id, value, onChange }: { id: string; value: string; onChange: (engine: string) => void }) {
  const hub = useDesk((s) => s.hub);
  const [engines, setEngines] = useState<EngineInfo[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    hub
      ?.engines()
      .then((e) => live && setEngines(e))
      .catch(() => live && setEngines(null));
    return () => {
      live = false;
    };
  }, [hub]);
  const lined = (engines ?? []).filter((e) => {
    const view = e.views[0];
    const line = view ? e.caps[view]?.line : undefined;
    return line !== undefined && line !== "none";
  });
  const choices: string[] = engines ? startable(lined) : ["claude", "codex"];
  if (!choices.includes(value)) choices.unshift(value);
  const title = (e: string) => ENGINE_TITLE[e as keyof typeof ENGINE_TITLE] ?? e;
  return (
    <select id={id} className="ability-select" aria-label="New sessions run" value={value} onChange={(e) => onChange(e.target.value)}>
      {choices.map((e) => (
        <option key={e} value={e}>
          {title(e)}
        </option>
      ))}
    </select>
  );
}

const workspacesLine = (labels: string[]): string =>
  labels.length === 0
    ? "Only what each workspace shares with Desk"
    : `${labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`}: only what ${labels.length === 1 ? "that workspace shares" : "each workspace shares"} with Desk`;

function Check({
  label,
  sub,
  checked,
  onChange,
  children,
  problem,
}: {
  label: string;
  sub?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  children?: React.ReactNode;
  problem?: { id: string; text: string | null };
}) {
  return (
    <div className="oversee-row">
      <label className="oversee-check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {sub ? (
          <span className="oversee-check-text">
            <b>{label}</b>
            <span className="oversee-sub">{sub}</span>
          </span>
        ) : (
          <span className="oversee-check-text">{label}</span>
        )}
      </label>
      {children}
      {problem?.text && <Problem id={problem.id} text={problem.text} />}
    </div>
  );
}

/** A text field and Add: Enter adds too; what's wrong with what's typed is
 *  said under it. */
function AddItem({
  label,
  placeholder,
  problemId,
  value,
  onChange,
  onAdd,
  disabled = false,
}: {
  label: string;
  placeholder: string;
  problemId: string;
  value: Typed;
  onChange: (text: string) => void;
  onAdd: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="field oversee-add">
      <div className="field-row">
        <input
          className="mono"
          aria-label={label}
          placeholder={placeholder}
          value={value.text}
          disabled={disabled}
          aria-invalid={value.problem ? true : undefined}
          aria-describedby={value.problem ? problemId : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !disabled) {
              e.preventDefault();
              onAdd();
            }
          }}
        />
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || !value.text.trim()} onClick={onAdd}>
          Add
        </button>
      </div>
      {value.problem && <Problem id={problemId} text={value.problem} />}
    </div>
  );
}

function Problem({ id, text }: { id: string; text: string }) {
  return (
    <span id={id} className="oversee-problem small state-blocked" role="alert">
      {text}
    </span>
  );
}

/** A minutes, time or count field: saved on Enter or leaving it; what's
 *  wrong with what's typed is said under it. */
function Num({
  label,
  value,
  onChange,
  onCommit,
  disabled = false,
  unit,
  time = false,
  narrow = false,
  problemId,
}: {
  label: string;
  value: Typed;
  /** Where what's wrong with it is said. */
  problemId: string;
  onChange: (text: string) => void;
  onCommit: () => void;
  disabled?: boolean;
  unit?: string;
  time?: boolean;
  narrow?: boolean;
}) {
  const id = problemId;
  return (
    <span className="oversee-num">
      <input
        className={`num ${narrow ? "num-narrow" : ""}`}
        aria-label={label}
        inputMode={time ? "text" : "numeric"}
        placeholder={time ? "09:00" : undefined}
        value={value.text}
        disabled={disabled}
        aria-invalid={value.problem ? true : undefined}
        aria-describedby={value.problem ? id : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          }
        }}
      />
      {unit && <span className="oversee-sub">{unit}</span>}
    </span>
  );
}
