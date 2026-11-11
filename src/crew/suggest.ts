import type { DeskHub } from "../hub/client";
import type { Session, SpendView } from "../hub/types";
import { repoFacts, type RepoFacts } from "../platform";
import { MAX_FULL_BUDGET_USD, parseRepo, parseWorkflow } from "./oversight";

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

/** `remote` without a user name, password or token (`https://user:token@`,
 *  `oauth2:…@`): only `git@`, how scp-like addresses are written, is kept. */
export const withoutCredentials = (remote: string): string => {
  const t = remote.trim();
  const url = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^@/]*@)?(.*)$/i.exec(t);
  if (url) return `${url[1]}${url[2]}`;
  const scp = /^([^@/]+)@([^:/]+):(.*)$/.exec(t);
  if (scp)
    return scp[1] === "git" ? `git@${scp[2]}:${scp[3]}` : `${scp[2]}:${scp[3]}`;
  return t;
};

/** How a remote is named for Act fully: `owner/name` on GitHub, as the hub
 *  matches it on any worktree (a page under the repo is the repo); another
 *  host's address as it is; never with credentials. */
export const repoName = (remote: string): string => {
  const t = withoutCredentials(remote);
  const m =
    /^(?:[a-z][a-z0-9+.-]*:\/\/([^/:]+)(?::\d+)?\/|(?:git@)?([^:/\s]+):)(.+?)\/?$/i.exec(
      t,
    );
  const host = (m?.[1] ?? m?.[2])?.toLowerCase();
  const parts = (m?.[3] ?? "").replace(/\.git$/, "").split("/");
  if (
    host === GITHUB &&
    parts.length >= 2 &&
    parts.slice(0, 2).every((p) => /^[\w.-]+$/.test(p))
  )
    return `${parts[0]}/${parts[1]}`;
  return t;
};

/** The repos and workflows `facts` suggest, each once and each as the hub
 *  takes it (a repo by its remote, else by its folder; anything else, a
 *  `file://` address or an odd path, left out), workflows up to the hub's
 *  most. */
export const fromFacts = (
  facts: readonly RepoFacts[],
): { repos: string[]; workflows: string[] } => {
  const repos = facts
    .map((f) => (f.remote ? repoName(f.remote) : f.top))
    .reduce<string[]>((kept, r) => {
      const ok = parseRepo(r, kept);
      return "value" in ok ? [...kept, ok.value] : kept;
    }, []);
  const workflows = [...new Set(facts.flatMap((f) => f.workflows))]
    .sort()
    .reduce<string[]>((kept, w) => {
      const ok = parseWorkflow(w, kept);
      return "value" in ok ? [...kept, ok.value] : kept;
    }, []);
  return { repos, workflows };
};

/** A daily budget with no metered spend to go on: it caps only what an API
 *  key or a cloud account would be billed. */
export const PLAN_ONLY_BUDGET_USD = 10;

/** A daily budget from a week of spend by account: about twice the
 *  metered spend of an average day, in steps of $5, at least $5. Calls on
 *  your Claude or ChatGPT plans bill nobody, so they don't count; an
 *  account whose billing is mixed or unknown is left out. */
export const budgetFrom = (
  week: SpendView | null,
): { usd: number; metered: boolean } => {
  const metered = (week?.rows ?? [])
    .filter(
      (r) =>
        r.totals.billing.length > 0 &&
        r.totals.billing.every((b) => b === "key" || b === "vendor"),
    )
    .reduce((sum, r) => sum + r.totals.usd, 0);
  if (!(metered > 0)) return { usd: PLAN_ONLY_BUDGET_USD, metered: false };
  return {
    usd: Math.min(
      MAX_FULL_BUDGET_USD,
      Math.max(5, Math.ceil(((metered / 7) * 2) / 5) * 5),
    ),
    metered: true,
  };
};

/** The folders to read repos from: this computer's sessions', then the
 *  folders spent in this month (sessions since ended). */
export const foldersOf = (
  sessions: readonly Session[],
  month: SpendView | null,
): string[] => [
  ...new Set([
    ...sessions.filter((s) => !s.machine && s.cwd).map((s) => s.cwd),
    ...(month?.rows ?? []).flatMap((r) => (r.folder ? [r.folder] : [])),
  ]),
];

/** Reads what Act fully's setup suggests for this computer. */
export async function suggestFull(
  hub: DeskHub,
  sessions: readonly Session[],
): Promise<FullSuggestion> {
  const [month, week] = await Promise.all([
    hub.spend("month", "project", 50).catch(() => null),
    hub.spend("week", "account", 50).catch(() => null),
  ]);
  const { repos, workflows } = fromFacts(
    await repoFacts(foldersOf(sessions, month)),
  );
  const budget = budgetFrom(week);
  return { repos, workflows, budgetUsd: budget.usd, metered: budget.metered };
}
