import type { DeskHub } from "../hub/client";
import type { Session, SpendView } from "../hub/types";
import { repoFacts, type RepoFacts } from "../platform";

/** What Act fully's setup suggests: repos, workflows and a daily budget,
 *  read before anything is written. */
export interface FullSuggestion {
  repos: string[];
  workflows: string[];
  /** Dollars a day. */
  budgetUsd: number;
  /** Whether any spend billed by the call (an API key, a cloud account)
   *  was seen: without, the budget caps only such spend from now on. */
  metered: boolean;
}

/** The host a repo named without one is on, as the hub reads it. */
const GITHUB = "github.com";

/** How a remote is named for Act fully: `owner/name` on GitHub, as the hub
 *  matches it on any worktree; another host's address as it is. */
export const repoName = (remote: string): string => {
  const t = remote.trim();
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|(?:[^@\s]+@)?([^:/\s]+):)(.+?)(?:\.git)?\/?$/i.exec(t);
  const host = (m?.[1] ?? m?.[2])?.toLowerCase();
  const path = m?.[3];
  return host === GITHUB && path && /^[\w.-]+\/[\w.-]+$/.test(path) ? path : t;
};

/** The repos and workflows `facts` suggest, each once: a repo by its
 *  remote, else by its folder. */
export const fromFacts = (facts: readonly RepoFacts[]): { repos: string[]; workflows: string[] } => {
  const repos = [...new Set(facts.map((f) => (f.remote ? repoName(f.remote) : f.top)))];
  const workflows = [...new Set(facts.flatMap((f) => f.workflows))].sort();
  return { repos, workflows };
};

/** A daily budget with no metered spend to go on: it caps only what an API
 *  key or a cloud account would be billed. */
export const PLAN_ONLY_BUDGET_USD = 10;

/** A daily budget from a week of spend by account: about twice the
 *  metered spend of an average day, in steps of $5, at least $5. Calls on
 *  your Claude or ChatGPT plans bill nobody, so they don't count; an
 *  account whose billing is mixed or unknown is left out. */
export const budgetFrom = (week: SpendView | null): { usd: number; metered: boolean } => {
  const metered = (week?.rows ?? [])
    .filter((r) => r.totals.billing.length > 0 && r.totals.billing.every((b) => b === "key" || b === "vendor"))
    .reduce((sum, r) => sum + r.totals.usd, 0);
  if (!(metered > 0)) return { usd: PLAN_ONLY_BUDGET_USD, metered: false };
  return { usd: Math.max(5, Math.ceil(((metered / 7) * 2) / 5) * 5), metered: true };
};

/** The folders to read repos from: this computer's sessions', then the
 *  folders spent in this month (sessions since ended). */
export const foldersOf = (sessions: readonly Session[], month: SpendView | null): string[] => [
  ...new Set([
    ...sessions.filter((s) => !s.machine && s.cwd).map((s) => s.cwd),
    ...(month?.rows ?? []).flatMap((r) => (r.folder ? [r.folder] : [])),
  ]),
];

/** Reads what Act fully's setup suggests for this computer. */
export async function suggestFull(hub: DeskHub, sessions: readonly Session[]): Promise<FullSuggestion> {
  const [month, week] = await Promise.all([
    hub.spend("month", "project", 50).catch(() => null),
    hub.spend("week", "account", 50).catch(() => null),
  ]);
  const { repos, workflows } = fromFacts(await repoFacts(foldersOf(sessions, month)));
  const budget = budgetFrom(week);
  return { repos, workflows, budgetUsd: budget.usd, metered: budget.metered };
}
