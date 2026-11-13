import { useEffect, useId, useState } from "react";
import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { useDesk } from "../hub/store";
import { useOverview } from "../overview/store";
import { useAgentConfigs } from "../crew/agentBrain";
import { LevelPicker } from "../crew/LevelPicker";
import { parseBudget, setAgentOversight } from "../crew/oversight";
import { PRESET_NAME, withPreset, type Preset } from "../crew/presets";
import { suggestFull, type FullSuggestion } from "../crew/suggest";
import { plainError } from "../ui/plainError";
import { useSubHeading } from "./FloorShell";

const DISMISSED_KEY = "desk.overseer-card.dismissed";
const wasDismissed = (): boolean => {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
};

/** Whether the Floor asks who oversees the crew: the hub keeps an
 *  overseer, none oversees what no group's boss does, and there is an
 *  agent of this computer's to ask it of. */
export const asksForOverseer = (
  support: string,
  agentId: string | null | undefined,
  candidates: number,
): boolean => support === "yes" && !agentId && candidates > 0;

/** The agents of this computer that could oversee the crew: its hub's,
 *  none of them a group's boss (that's set from the group), its default
 *  agent first. */
export const candidatesOf = (
  roster: readonly Agent[],
  localHub: string | null,
  bosses: readonly string[],
): Agent[] =>
  roster
    .filter((a) => a.hubId === localHub && !bosses.includes(a.id))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

/** What's chosen for Act fully before it's applied: a daily budget,
 *  blank for none, and whether this week's spend was billed (what the
 *  suggested one is based on). */
interface FullPick {
  metered: boolean;
  budget: string;
}

/** The Floor's card while no one oversees the crew: pick who, and how
 *  much it does on its own, in one step; Act fully's budget is suggested
 *  from this week's spend before anything is written. Overseeing is the person's to
 *  set, so this is Desk's own card, never an agent's. */
export function OverseerCard({ inSetup = false }: { inSetup?: boolean } = {}) {
  const H = useSubHeading();
  const hub = useDesk((s) => s.hub);
  const sessions = useDesk((s) => s.sessions);
  const support = useOverview((s) => s.managerSupport);
  const manager = useOverview((s) => s.manager);
  const roster = useChat((s) => s.roster);
  const localHub = useChat((s) => s.hubs.find((h) => h.local)?.id ?? null);
  const candidates = candidatesOf(
    roster,
    localHub,
    (manager?.bosses ?? []).map((b) => b.agentId),
  );
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [who, setWho] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>("act");
  const [full, setFull] = useState<FullPick | "finding" | null>(null);
  const [state, setState] = useState<
    { kind: "idle" | "saving" } | { kind: "failed"; problem: string }
  >({ kind: "idle" });
  const ids = useId();
  const agent = candidates.find((a) => a.id === who) ?? candidates[0];
  // Only Act fully takes a budget: it is asked, and written, for it alone.
  const wantsFull = preset === "full";

  useEffect(() => {
    if (!hub || !wantsFull || full !== null) return;
    setFull("finding");
    void suggestFull(hub, Object.values(sessions))
      .catch((): FullSuggestion => ({
        repos: [],
        workflows: [],
        budgetUsd: 10,
        metered: false,
      }))
      .then((s) => setFull({ metered: s.metered, budget: String(s.budgetUsd) }));
  }, [hub, wantsFull, full, sessions]);

  if (
    (dismissed && !inSetup) ||
    !agent ||
    !asksForOverseer(support, manager?.agentId, candidates.length)
  )
    return null;

  const pick = full && full !== "finding" ? full : null;
  // Blank is no budget; one given is one the hub takes.
  const blank = !pick || pick.budget.trim() === "";
  const budget = blank ? null : parseBudget(pick.budget);
  const budgetUsd = budget && "value" in budget ? budget.value : null;
  const budgetProblem = budget && "problem" in budget ? budget.problem : null;
  // Act fully needs nothing else: it saves while the suggestion is found.
  const ready = !wantsFull || !budgetProblem;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* asked again next time */
    }
    setDismissed(true);
  };

  const apply = async () => {
    if (!hub || !ready) return;
    setState({ kind: "saving" });
    try {
      const toml = await setAgentOversight(hub, agent.id, (o) => {
        const next = withPreset({ ...o, group: null }, preset);
        return preset === "full"
          ? { ...next, full: { ...next.full, budgetUsdPerDay: budgetUsd } }
          : next;
      });
      useAgentConfigs.getState().put(agentKey(agent), toml);
      const s = useOverview.getState();
      await s.loadManager();
      if (s.overviewSupport === "yes") void s.loadOverview();
      setState({ kind: "idle" });
    } catch (e) {
      setState({ kind: "failed", problem: plainError(e) });
    }
  };

  return (
    <section
      className="floor-card overseer-card"
      aria-labelledby={`${ids}-title`}
    >
      {/* In the setup, its step says what it is: the title stays for its name. */}
      <div className={`floor-card-head${inSetup ? " sr-only" : ""}`}>
        <H id={`${ids}-title`} className="display floor-card-title">
          No one oversees your crew
        </H>
        {/* In the setup, its own Skip puts it off. */}
        {!inSetup && (
          <button
            type="button"
            className="btn btn-ghost btn-sm floor-card-close"
            onClick={dismiss}
          >
            Not now
          </button>
        )}
      </div>
      {!inSetup && (
        <p className="small muted">
          An overseer keeps track of every agent and session, tells you what
          needs you and, at Act, does the work itself. You can change any of
          this later in its settings.
        </p>
      )}
      {candidates.length > 1 && (
        <label className="overseer-who">
          <span className="small">Who oversees</span>
          <select
            className="ability-select"
            value={agent.id}
            onChange={(e) => setWho(e.target.value)}
          >
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <LevelPicker
        value={preset}
        onPick={setPreset}
        label={`How much ${agent.name} does on its own`}
      />
      {wantsFull && (
        <div
          className="oversee-card overseer-full"
          aria-busy={full === "finding"}
        >
          {!pick ? (
            <p className="small faint oversee-row">
              Looking at this week’s spend…
            </p>
          ) : (
            <>
              <div className="oversee-row">
                <label className="oversee-check-text" htmlFor={`${ids}-budget`}>
                  <b>Daily budget</b>
                  <span className="oversee-sub">
                    {pick.metered
                      ? "About twice a day’s spend billed to your API keys this week. Leave it blank for none."
                      : "Nothing this week was billed to an API key or a cloud account, so this caps only such spend. Leave it blank for none."}
                  </span>
                </label>
                <span className="oversee-num">
                  $
                  <input
                    id={`${ids}-budget`}
                    className="num"
                    inputMode="decimal"
                    value={pick.budget}
                    aria-invalid={budgetProblem ? true : undefined}
                    onChange={(e) =>
                      setFull({ ...pick, budget: e.target.value })
                    }
                  />
                  a day
                </span>
              </div>
              {budgetProblem && (
                <p className="small state-blocked oversee-row">
                  {budgetProblem}
                </p>
              )}
            </>
          )}
        </div>
      )}
      {preset === "full" && (
        <p className="small state-blocked">
          No limits: it does everything itself, including publishing, deploys
          and secrets. Give it a daily budget if you want one.
        </p>
      )}
      {state.kind === "failed" && (
        <p className="small state-blocked">{state.problem}</p>
      )}
      <div className="overseer-foot">
        <button
          type="button"
          className="btn btn-signal"
          disabled={!ready || state.kind === "saving"}
          onClick={() => void apply()}
        >
          {state.kind === "saving"
            ? "Saving…"
            : `${agent.name} oversees at ${PRESET_NAME[preset]}`}
        </button>
      </div>
    </section>
  );
}
