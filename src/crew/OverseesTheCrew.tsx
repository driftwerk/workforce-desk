import { useEffect, useId, useRef, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { useDesk } from "../hub/store";
import type { OversightLevel } from "../hub/types";
import { useOverview } from "../overview/store";
import { CloseButton, Dialog, radioKeys } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import { useAgentConfigs } from "./agentBrain";
import { oversightOf, parseCheckins, parseMinutes, parseTime, readable, setAgentOversight, type Oversight } from "./oversight";

const LEVELS: { id: OversightLevel; name: string; desc: string }[] = [
  { id: "watch", name: "Watch", desc: "Answers “what’s everyone doing?” and tells you when something needs you." },
  { id: "suggest", name: "Suggest", desc: "Also proposes what to do. Nothing happens until you say yes." },
  { id: "act", name: "Act", desc: "Handles the routine itself, within the rules below, and tells you what it did." },
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
  checkins: typed(String(o.maxCheckinsPerDay)),
});

type Field = "waiting" | "quiet" | "morning" | "evening" | "checkins";

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
  const setCheckins = (o: Oversight, text: string) => {
    const r = parseCheckins(text);
    return "problem" in r ? r.problem : { ...o, maxCheckinsPerDay: r.value };
  };
  /** Turning a row with a field on uses what's typed in it, if it can. */
  const turnOn = (f: Field, apply: (o: Oversight, text: string) => Oversight | string, off: Change) => (on: boolean) => {
    if (!o || !fields) return;
    if (!on) return update(off);
    const result = apply(o, fields[f].text);
    if (typeof result === "string") return setFields({ ...fields, [f]: { ...fields[f], problem: result } });
    update(() => result);
  };

  const enable = (on: boolean) => {
    if (on && other) return setConfirming(true);
    update((x) => ({ ...x, enabled: on }));
  };

  const current = o ? LEVELS.findIndex((l) => l.id === o.level) : -1;

  return (
    <section className="agent-section oversee" aria-labelledby={head}>
      <div className="oversee-top">
        <span className="oversee-intro">
          <h2 id={head}>Oversees the crew</h2>
          <span className="oversee-sub">
            {name} keeps track of every agent and session and tells you what needs you. Only one crew member oversees at a time.
          </span>
          {o && !o.enabled && other && <span className="oversee-sub">{other} oversees the crew now.</span>}
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
            <div className="oversee-levels" role="radiogroup" aria-label="How much it does on its own">
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
                label="Crew on this Mac"
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
                sub={workspacesLine(hubs.filter((h) => !h.local).map((h) => h.label))}
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
                problemId={`${ids}-checkins`}
                label="Check-ins a day"
                value={fields.checkins}
                onChange={(t) => setField("checkins", t)}
                onCommit={() => commit("checkins", setCheckins)}
                narrow
              />{" "}
              times a day. Events close together are taken as one.
            </span>
            {fields.checkins.problem && <Problem id={`${ids}-checkins`} text={fields.checkins.problem} />}
          </div>

          {o.level === "act" && (
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
                  sub="Start sessions and give tasks to the crew"
                  checked={o.act.handOutWork}
                  onChange={(v) => update((x) => ({ ...x, act: { ...x.act, handOutWork: v } }))}
                />
              </div>
              <span className="oversee-sub">
                {name} always asks you first before pushing code, deleting anything, or sending messages outside Desk. Everything it
                does shows in Activity with its reason.
              </span>
            </div>
          )}
        </>
      )}

      {confirming && other && (
        <Dialog
          onClose={() => setConfirming(false)}
          title={(id) => (
            <header className="dialog-head">
              <span className="dialog-title">
                <h1 id={id} className="display-md">
                  Make {name} the overseer?
                </h1>
                <p>
                  {other} oversees the crew now — make {name} the overseer instead? {other} stops overseeing; nothing else about{" "}
                  {other} changes.
                </p>
              </span>
              <CloseButton onClose={() => setConfirming(false)} />
            </header>
          )}
        >
          <footer className="dialog-foot">
            <span className="dialog-foot-note" />
            <button type="button" className="btn btn-ghost" data-autofocus onClick={() => setConfirming(false)}>
              Keep {other}
            </button>
            <button
              type="button"
              className="btn btn-signal"
              onClick={() => {
                setConfirming(false);
                update((x) => ({ ...x, enabled: true }));
              }}
            >
              Make {name} the overseer
            </button>
          </footer>
        </Dialog>
      )}
    </section>
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
