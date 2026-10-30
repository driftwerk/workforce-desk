import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { agentKey, type Agent } from "../chat/types";
import type { AgentHeartbeat } from "../hub/client";
import { effortName } from "../hub/providers";
import { useDesk } from "../hub/store";
import { radioKeys } from "../ui/Dialog";
import { plainError } from "../ui/plainError";
import {
  abilitiesOf,
  ADVISOR_EFFORTS,
  DESK_DEFAULTS,
  HEARTBEAT_EVERY,
  MAX_ANGLES,
  rememberDefaults,
  rememberDiffers,
  setAgentAbilities,
  TIDY_EVERY,
  type Abilities as AbilitiesT,
  type KnowHow,
} from "./abilities";
import { useAgentConfigs } from "./agentBrain";
import { parseTime } from "./oversight";

type Change = (a: AbilitiesT) => AbilitiesT;
type Status = { state: "idle" | "saving" | "saved" } | { state: "failed"; problem: string };

/** An agent's abilities as its config says, and a way to change them: each
 *  change shows at once, is written into the agent's own `config.toml`, and
 *  goes back to what the file says if the write fails. */
export function useAbilities(agent: Agent) {
  const desk = useDesk((s) => s.hub);
  const key = agentKey(agent);
  const config = useAgentConfigs((s) => s.configs[key]);
  const put = useAgentConfigs((s) => s.put);
  const [a, setA] = useState<AbilitiesT | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const saving = useRef(0);

  useEffect(() => {
    if (desk && config === undefined) void useAgentConfigs.getState().load(desk, agent);
  }, [desk, config, agent]);
  // The file as last read or written, unless a change of ours is on its way.
  useEffect(() => {
    if (config === undefined || saving.current > 0) return;
    setA(abilitiesOf(config));
  }, [config]);

  const update = (change: Change) => {
    if (!desk || !a) return;
    setA(change(a));
    setStatus({ state: "saving" });
    saving.current += 1;
    const write = writes.current.then(() => setAgentAbilities(desk, agent.id, change));
    writes.current = write.catch(() => {});
    write.then(
      (toml) => {
        saving.current -= 1;
        put(key, toml);
        setStatus({ state: "saved" });
      },
      (e: unknown) => {
        saving.current -= 1;
        setStatus({ state: "failed", problem: plainError(e) });
        // Back to what the file says.
        const now = useAgentConfigs.getState().configs[key] ?? config;
        if (now !== undefined) setA(abilitiesOf(now));
      },
    );
  };

  return { a, update, status };
}

function Saving({ status }: { status: Status }) {
  if (status.state === "idle") return null;
  return (
    <p className={`small ${status.state === "failed" ? "state-blocked" : status.state === "saved" ? "state-done" : "faint"}`} role="status">
      {status.state === "failed" ? status.problem : status.state === "saving" ? "Saving…" : "Saved."}
    </p>
  );
}

/** A switch with its name and what it does; `children` are its options,
 *  shown while it is on. */
function Ability({
  name,
  sub,
  on,
  onChange,
  disabled,
  children,
}: {
  name: string;
  sub: ReactNode;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="ability-row">
      <span className="ability-text">
        <b id={id}>{name}</b>
        <span className="ability-sub">{sub}</span>
        {on && children}
      </span>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={on}
        aria-labelledby={id}
        disabled={disabled}
        onClick={() => onChange(!on)}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}

function Every({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: number;
  choices: { secs: number; name: string }[];
  onChange: (secs: number) => void;
}) {
  const id = useId();
  const known = choices.some((c) => c.secs === value);
  return (
    <>
      <label htmlFor={id}>Every</label>
      <select id={id} className="ability-select" aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {!known && <option value={value}>{Math.round(value / 60)} minutes</option>}
        {choices.map((c) => (
          <option key={c.secs} value={c.secs}>
            {c.name}
          </option>
        ))}
      </select>
    </>
  );
}

/** Memory, as the hub can tell: how many things they remember, how many
 *  lessons, when it was last tidied. */
export interface MemorySummary {
  memories: number;
  lessons: number;
  tidiedAt: string | null;
}

/** "How they remember": what they keep from conversations, the lessons
 *  they learn, getting better at the work, tidying, and rapport. */
export function HowTheyRemember({ agent, ago }: { agent: Agent; ago: (at: string) => string }) {
  const { a, update, status } = useAbilities(agent);
  const desk = useDesk((s) => s.hub);
  const [summary, setSummary] = useState<MemorySummary | null>(null);
  useEffect(() => {
    if (!desk) return;
    let live = true;
    // A hub that can't say leaves the summary out.
    desk.memorySummary(agent.id).then(
      (s) => live && setSummary({ memories: s.memories, lessons: s.lessons, tidiedAt: s.tidied_at }),
      () => live && setSummary(null),
    );
    return () => {
      live = false;
    };
  }, [desk, agent.id]);
  const name = agent.name;
  const off = !a;
  const v = a ?? DESK_DEFAULTS;
  return (
    <section id="remember" className="agent-section" aria-labelledby="remember-head">
      <div className="ability-head">
        <h2 id="remember-head">How they remember</h2>
        {a && rememberDiffers(a) && (
          <button type="button" className="btn btn-ghost" onClick={() => update(rememberDefaults)}>
            Back to Desk’s defaults
          </button>
        )}
      </div>
      <div className="ability-card">
        {summary && (
          <div className="ability-row ability-summary">
            <span className="ability-text">
              <b>
                {name} remembers {count(summary.memories, "thing")} and has learned {count(summary.lessons, "lesson")}
              </b>
              {summary.tidiedAt && <span className="ability-sub">Last tidied {ago(summary.tidiedAt)}</span>}
            </span>
          </div>
        )}
        <Ability
          name="Remembers what you talk about"
          sub="After a conversation they note what’s worth keeping: your preferences, decisions, people and projects."
          on={v.passive}
          disabled={off}
          onChange={(on) => update((x) => ({ ...x, passive: on }))}
        />
        <Ability
          name="Learns from mistakes"
          sub="When something goes wrong or you correct them, they write down the lesson and recall it next time it applies."
          on={v.lessons}
          disabled={off}
          onChange={(on) => update((x) => ({ ...x, lessons: on }))}
        />
        <Ability
          name="Gets better at the work"
          sub="Looks back over finished work in the background and keeps what made it go well."
          on={v.learn}
          disabled={off}
          onChange={(on) => update((x) => ({ ...x, learn: on }))}
        />
        <Ability
          name="Tidies their memory"
          sub="Merges duplicates and turns day-to-day notes into lasting knowledge."
          on={v.tidy}
          disabled={off}
          onChange={(on) => update((x) => ({ ...x, tidy: on }))}
        >
          <span className="ability-opts">
            <Every
              label="How often they tidy"
              value={v.tidyEvery}
              choices={TIDY_EVERY}
              onChange={(secs) => update((x) => ({ ...x, tidyEvery: secs }))}
            />
          </span>
        </Ability>
        <Ability
          name="Notices how things are going with you"
          sub="Keeps a feel for how your conversations go, so they can own it when something went badly."
          on={v.rapport}
          disabled={off}
          onChange={(on) => update((x) => ({ ...x, rapport: on }))}
        />
      </div>
      <Saving status={status} />
      <p className="ability-sub ability-note">
        Remembering and tidying use your Claude plan, with a quicker model than their own. Memories stay on this computer.
      </p>
    </section>
  );
}

const count = (n: number, what: string) => `${n.toLocaleString()} ${what}${n === 1 ? "" : "s"}`;

const KNOW_HOW: { id: KnowHow; name: string; sub: string }[] = [
  { id: "off", name: "Off", sub: "They don’t pick up how-to knowledge from their work." },
  {
    id: "shadow",
    name: "Learning quietly",
    sub: "They collect how-to knowledge from finished work but don’t use it yet, so you can look it over first.",
  },
  { id: "on", name: "Using it", sub: "They collect how-to knowledge from finished work and use it when it fits." },
];

/** "How they work": second opinions, checking claims, chaining tools, and
 *  know-how. */
export function HowTheyWork({ agent }: { agent: Agent }) {
  const { a, update, status } = useAbilities(agent);
  const ids = useId();
  const off = !a;
  const v = a ?? DESK_DEFAULTS;
  const [angles, setAngles] = useState<{ text: string; problem: string | null }>({ text: String(v.angles), problem: null });
  useEffect(() => setAngles({ text: String(v.angles), problem: null }), [v.angles]);
  const current = KNOW_HOW.findIndex((k) => k.id === v.knowHow);
  const commitAngles = () => {
    const n = Number(angles.text.trim());
    if (!/^\d+$/.test(angles.text.trim()) || n < 1 || n > MAX_ANGLES) {
      setAngles({ ...angles, problem: `Use 1 to ${MAX_ANGLES}: that’s as many as run at once on this computer.` });
      return;
    }
    if (n !== v.angles) update((x) => ({ ...x, angles: n }));
  };
  return (
    <section id="work" className="agent-section" aria-labelledby="work-head">
      <div className="ability-head">
        <h2 id="work-head">How they work</h2>
      </div>
      <div className="ability-card">
        <Ability
          name="Asks for a second opinion"
          sub="On hard problems they check their thinking with an advisor before answering."
          on={v.advisor}
          disabled={off}
          onChange={(on) => update((x) => ({ ...x, advisor: on }))}
        >
          <span className="ability-opts">
            <label htmlFor={`${ids}-effort`}>Advisor effort</label>
            <select
              id={`${ids}-effort`}
              className="ability-select"
              value={v.advisorEffort}
              onChange={(e) => update((x) => ({ ...x, advisorEffort: e.target.value as AbilitiesT["advisorEffort"] }))}
            >
              {ADVISOR_EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {effortName(e)}
                </option>
              ))}
            </select>
            <span className="ability-gap" />
            <label htmlFor={`${ids}-angles`}>Looks from up to</label>
            <input
              id={`${ids}-angles`}
              className="num num-narrow"
              inputMode="numeric"
              value={angles.text}
              aria-invalid={angles.problem ? true : undefined}
              aria-describedby={angles.problem ? `${ids}-angles-problem` : undefined}
              onChange={(e) => setAngles({ text: e.target.value, problem: null })}
              onBlur={commitAngles}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitAngles();
                }
              }}
            />
            <span>angles at once</span>
          </span>
          {angles.problem && (
            <span id={`${ids}-angles-problem`} className="small state-blocked" role="alert">
              {angles.problem}
            </span>
          )}
        </Ability>
        <Ability
          name="Checks what they claim"
          sub="Before answering, they check what they’re about to say against what their tools actually returned."
          on={v.grounding}
          disabled={off}
          onChange={(on) => update((x) => ({ ...x, grounding: on }))}
        />
        <Ability
          name="Chains tools together"
          sub="For big lookups they can run several tools in one go instead of one at a time."
          on={v.programs}
          disabled={off}
          onChange={(on) => update((x) => ({ ...x, programs: on }))}
        />
        <div className="ability-row ability-row-center">
          <span className="ability-text">
            <b id={`${ids}-knowhow`}>Know-how</b>
            <span className="ability-sub">{KNOW_HOW[Math.max(current, 0)]!.sub}</span>
          </span>
          <div className="seg ability-seg" role="radiogroup" aria-labelledby={`${ids}-knowhow`}>
            {KNOW_HOW.map((k, i) => (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={v.knowHow === k.id}
                tabIndex={i === current ? 0 : -1}
                disabled={off}
                onClick={() => v.knowHow !== k.id && update((x) => ({ ...x, knowHow: k.id }))}
                onKeyDown={(e) => radioKeys(e, KNOW_HOW, current, (next) => next.id !== v.knowHow && update((x) => ({ ...x, knowHow: next.id })))}
              >
                {k.name}
              </button>
            ))}
          </div>
        </div>
      </div>
      <Saving status={status} />
    </section>
  );
}

/** What's typed in a time field, and what's wrong with it. */
interface Typed {
  text: string;
  problem: string | null;
}

/** "Checking in": the agent going through its check-in list (HEARTBEAT.md)
 *  on a schedule, and messaging the person in its Desk chat only when
 *  something needs them. */
export function CheckingIn({ agent, ago, onEditList }: { agent: Agent; ago: (at: string) => string; onEditList: () => void }) {
  const desk = useDesk((s) => s.hub);
  const { a, update, status } = useAbilities(agent);
  const ids = useId();
  const off = !a;
  const v = a ?? DESK_DEFAULTS;
  const [hb, setHb] = useState<AgentHeartbeat | null>(null);
  const [from, setFrom] = useState<Typed>({ text: v.quietFrom, problem: null });
  const [to, setTo] = useState<Typed>({ text: v.quietTo, problem: null });
  useEffect(() => setFrom({ text: v.quietFrom, problem: null }), [v.quietFrom]);
  useEffect(() => setTo({ text: v.quietTo, problem: null }), [v.quietTo]);
  useEffect(() => {
    if (!desk || !v.heartbeat) return;
    let live = true;
    desk.agentHeartbeat(agent.id).then(
      (h) => live && setHb(h),
      () => live && setHb(null),
    );
    return () => {
      live = false;
    };
  }, [desk, agent.id, v.heartbeat]);

  /** Quiet hours are both times or neither. */
  const commitQuiet = () => {
    const parse = (t: Typed): string | { problem: string } => {
      if (!t.text.trim()) return "";
      const r = parseTime(t.text);
      return "problem" in r ? r : r.value;
    };
    const f = parse(from);
    const t = parse(to);
    if (typeof f !== "string") return setFrom({ ...from, problem: f.problem });
    if (typeof t !== "string") return setTo({ ...to, problem: t.problem });
    if ((f === "") !== (t === "")) {
      const problem = "Give both times, or neither for no quiet hours.";
      return f === "" ? setFrom({ ...from, problem }) : setTo({ ...to, problem });
    }
    if (f !== v.quietFrom || t !== v.quietTo) update((x) => ({ ...x, quietFrom: f, quietTo: t }));
  };
  const timeField = (label: string, value: Typed, set: (t: Typed) => void, id: string) => (
    <input
      id={id}
      className="num"
      aria-label={label}
      placeholder="22:00"
      value={value.text}
      aria-invalid={value.problem ? true : undefined}
      aria-describedby={value.problem ? `${ids}-quiet-problem` : undefined}
      onChange={(e) => set({ text: e.target.value, problem: null })}
      onBlur={commitQuiet}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitQuiet();
        }
      }}
    />
  );
  const problem = from.problem ?? to.problem;
  const items = hb ? `${hb.items} ${hb.items === 1 ? "thing" : "things"} on it` : null;
  const last = hb?.last_checked
    ? `last checked ${ago(hb.last_checked)}${hb.needed_you === false ? ", nothing needed you" : hb.needed_you ? ", something needed you" : ""}`
    : hb
      ? "not checked yet"
      : null;
  return (
    <section id="checkin" className="agent-section" aria-labelledby="checkin-head">
      <div className="ability-head">
        <h2 id="checkin-head">Checking in</h2>
      </div>
      <div className="ability-card">
        <Ability
          name="Checks in on their own"
          sub="They go through their check-in list on a schedule and message you only when something needs you."
          on={v.heartbeat}
          disabled={off}
          onChange={(on) => update((x) => ({ ...x, heartbeat: on }))}
        >
          <span className="ability-opts">
            <Every
              label="How often they check in"
              value={v.heartbeatEvery}
              choices={HEARTBEAT_EVERY}
              onChange={(secs) => update((x) => ({ ...x, heartbeatEvery: secs }))}
            />
            <span className="ability-gap" />
            <label htmlFor={`${ids}-from`}>Quiet from</label>
            {timeField("Quiet from", from, setFrom, `${ids}-from`)}
            <label htmlFor={`${ids}-to`}>to</label>
            {timeField("Quiet until", to, setTo, `${ids}-to`)}
          </span>
          {problem && (
            <span id={`${ids}-quiet-problem`} className="small state-blocked" role="alert">
              {problem}
            </span>
          )}
          <span className="ability-opts">
            <button type="button" className="btn" onClick={onEditList}>
              Edit the check-in list
            </button>
            {(items || last) && <span>{[items, last].filter(Boolean).join(" · ")}</span>}
          </span>
        </Ability>
      </div>
      <Saving status={status} />
    </section>
  );
}

export { Ability, Every, Saving };
