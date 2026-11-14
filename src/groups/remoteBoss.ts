// A group's boss on another hub (remote bosses, RBD1): an agent of a paired
// team hub (Allan on Driftwerk) made the boss of one of the person's groups.
// Desk's native side does all of it (src-tauri/src/bosses.rs): it asks the
// person natively, mints each engine's link with the paired device token,
// hands it over and writes the grants. The page sends ids and choices, and
// is told names and states, never a token.

import { HubError } from "../hub/client";
import { invoke } from "../platform";

/** How much the boss may do, as a grant says it (the Desk twin of the
 *  hub's `grant::Level`). */
export type BossLevel = "watch" | "suggest" | "act" | "full";

/** What the boss sees of the group's sessions (`grant::Sees`). */
export type BossSees = "status" | "replies" | "everything";

export const BOSS_LEVELS: readonly BossLevel[] = ["watch", "suggest", "act", "full"];
export const BOSS_SEES: readonly BossSees[] = ["status", "replies", "everything"];

/** The most Act fully's daily budget may be, as the hub has it. */
export const MAX_BUDGET_USD = 10_000;

/** What the person chose. */
export interface BossChoice {
  level: BossLevel;
  sees: BossSees;
  /** Act fully's daily budget in real money; none below it. */
  budgetUsdPerDay: number | null;
}

/** A boss on another hub starts at Suggest, seeing status and replies
 *  (remote-bosses §16, decision 4). */
export const FIRST_CHOICE: BossChoice = { level: "suggest", sees: "replies", budgetUsdPerDay: null };

/** One engine of a group's boss, as the native side read it. */
export interface BossEngine {
  engine: string;
  name: string;
  /** Whether a link is held there; when not, `problem` says why. */
  linked: boolean;
  sessions: number;
  /** Whether its grant serves the boss now; null when it couldn't be read. */
  live: boolean | null;
  /** Why not, in the engine's words. */
  why: string | null;
  /** Every boss there is paused by its own `desk-helper bosses stop`. */
  enginePaused: boolean;
  /** It took its stop since the group was paused. */
  stopped: boolean;
  expiresAt: string | null;
  reachedAt: string | null;
  problem: string | null;
  /** Other groups there the same boss runs below Act fully: "Atlas (suggest)". */
  belowFull: string[];
  /** Real money the boss spent on the group here today, at Act fully; null
   *  below it, or from a hub too old to say. */
  spentTodayUsd: number | null;
}

/** A group's boss on another hub. */
export interface RemoteBoss {
  hub: string;
  hubLabel: string;
  agent: string;
  /** `<hub>/<agent>`, as the engines name it. */
  party: string;
  choice: BossChoice;
  /** Paused, and every engine took its stop. */
  paused: boolean;
  /** Paused, but not every engine has taken its stop yet. */
  pausing: boolean;
  /** Stopped, but not every engine is clear yet. */
  stopping: boolean;
  /** The group's sessions the boss doesn't run until the person says so. */
  waiting: number;
  /** Real money the boss spent on the group today, every engine added up;
   *  null when one of them didn't say. */
  spentTodayUsd: number | null;
  engines: BossEngine[];
}

/** Whether a paired hub takes bosses from Desk. */
export type BossOffer = { kind: "takes" } | { kind: "not"; why: string };

/** What a change did, engine by engine. */
export interface BossDone {
  cancelled: boolean;
  done: string[];
  failed: { engine: string; why: string }[];
}

const call = async <T>(cmd: string, args: Record<string, unknown>): Promise<T> => {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new HubError(502, e instanceof Error ? e.message : String(e));
  }
};

/** The choice as the native side takes it: no budget below Act fully. */
const sent = (c: BossChoice) => ({ level: c.level, sees: c.sees, budgetUsdPerDay: c.level === "full" ? c.budgetUsdPerDay : null });

export const remoteBosses = {
  offer: (hub: string) => call<BossOffer>("boss_offer", { hub }),
  status: (group: string) => call<RemoteBoss | null>("boss_status", { group }),
  link: (group: string, hub: string, agent: string, choice: BossChoice) => call<BossDone>("boss_link", { group, hub, agent, choice: sent(choice) }),
  set: (group: string, choice: BossChoice) => call<BossDone>("boss_set", { group, choice: sent(choice) }),
  pause: (group: string) => call<BossDone>("boss_pause", { group }),
  resume: (group: string) => call<BossDone>("boss_resume", { group }),
  unlink: (group: string) => call<BossDone>("boss_unlink", { group }),
  /** Try again: linked where it failed, as the person last said. */
  retry: (group: string) => call<BossDone>("boss_retry", { group }),
  /** Lets every boss on an engine go on after its own pause (asked natively). */
  unpauseEngine: (group: string, engine: string) => call<BossDone>("boss_unpause_engine", { group, engine }),
  /** The sidebar changed: the native side brings the grants up to date soon. */
  layoutChanged: () => invoke<void>("boss_layout_changed").catch(() => {}),
};

export const LEVEL_NAME: Record<BossLevel, string> = {
  watch: "Watch only",
  suggest: "Suggest",
  act: "Act within Desk",
  full: "Act fully",
};

/** What each level does, said for `name` (remote-bosses §8.1). */
export const levelSays = (level: BossLevel, name: string): string =>
  ({
    watch: `${name} can look and tell you what they see.`,
    suggest: `${name} suggests; you decide each one, in Desk or Slack.`,
    act: `Runs the sessions you give ${name}; shipping comes to you.`,
    full: `Decides every request itself, under a daily budget.`,
  })[level];

export const SEES_NAME: Record<BossSees, string> = {
  status: "Status",
  replies: "Status and replies",
  everything: "Everything",
};

/** The one line the Act fully sheet carries: what still holds once the
 *  boss allows a request (checked against `charge.rs` `boss_decides`). */
export const fullLine = (boss: string): string =>
  `Once ${boss} allows a request, Desk’s ship and irreversible checks no longer apply; its hold, breaker and agent-settings checks still do.`;

/** Why `choice`, at Act fully, isn't in force for its boss `boss`, in
 *  plain words; null while it is (or the level isn't Act fully). `waits`:
 *  the hub's own words on the group's sessions waiting on the person
 *  (`waitsOnYou`, from `remote_unanswering`). */
export const notInForce = (b: RemoteBoss | null, choice: BossChoice, boss: string, waits: readonly string[] = []): string | null => {
  if (choice.level !== "full") return null;
  if (choice.budgetUsdPerDay === null || !(choice.budgetUsdPerDay > 0)) return `Act fully needs a daily budget for ${boss}.`;
  if (choice.budgetUsdPerDay > MAX_BUDGET_USD) return `A daily budget is at most $${MAX_BUDGET_USD.toLocaleString("en-US")}.`;
  if (choice.sees === "status") return `Act fully needs ${boss} to see replies.`;
  if (!b) return null;
  if (b.stopping) return `${boss} is being stopped: Desk is clearing the last of it.`;
  if (b.paused || b.pausing) return `${boss} is paused: nothing is decided until you let ${boss} go on.`;
  for (const e of b.engines) {
    if (!e.linked) return `${boss} isn’t linked on ${e.name}: ${(e.problem ?? "Try it again").replace(/\.$/, "")}.`;
    if (e.enginePaused) return `Every boss on ${e.name} was paused there: let them go on from this sheet.`;
    if (e.problem) return `Desk couldn’t reach ${e.name}: ${e.problem.replace(/\.$/, "")}.`;
    if (e.live === false) return e.why ?? `${boss} isn’t served on ${e.name} now.`;
    if (e.belowFull.length)
      return `${boss} also runs ${e.belowFull.join(", ")} on ${e.name}: Act fully needs every group ${boss} runs there at Act fully, with a budget.`;
  }
  if (b.choice.level !== "full") return null;
  return waits.find((w) => w.startsWith(boss) || w.includes(` ${boss} `)) ?? null;
};

/** Where an engine stands, for its row: its words and its dot. */
export const engineState = (e: BossEngine, boss: string): { text: string; dot: "done" | "blocked" | "idle" } => {
  const sessions = `${e.sessions} ${e.sessions === 1 ? "session" : "sessions"}`;
  const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (!e.linked) return { text: `${sessions} · not linked: ${e.problem ?? "try it again"}`, dot: "blocked" };
  if (e.problem) return { text: `${sessions} · not reached${e.reachedAt ? ` since ${time(e.reachedAt)}` : ""}: ${e.problem}`, dot: "blocked" };
  if (e.enginePaused) return { text: `${sessions} · every boss there is paused`, dot: "idle" };
  if (e.live === false) return { text: `${sessions} · ${e.why ?? `${boss} isn’t served here now`}`, dot: "idle" };
  const until = e.expiresAt ? new Date(e.expiresAt).toLocaleDateString([], { day: "numeric", month: "short" }) : null;
  return { text: until ? `${sessions} · linked until ${until}` : sessions, dot: "done" };
};

/** What a change did, said once: what failed, by engine. */
export const doneSaid = (d: BossDone): string | null =>
  d.failed.length ? d.failed.map((f) => `${f.engine}: ${f.why}`).join(" ") : null;
