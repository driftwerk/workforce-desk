import { create } from "zustand";
import { proposalFiles, removeProposal, writeProposal, writeTheme } from "../platform";
import { BUILTIN } from "./builtin";
import { freeId, parseProposal, parsePropose, parseRevise, propose, RESERVED_IDS, revise, serializeProposal, type Proposal } from "./proposal";
import { allThemes, resolveTheme, useThemeStore } from "./store";
import { serializeTheme, ThemeError } from "./toml";
import { derive, TOKENS, type ThemeSpec } from "./tokens";

interface ProposalsState {
  /** The proposals agents made that the person hasn't kept or discarded,
   *  newest first. */
  list: Proposal[];
  loaded: boolean;
  load: () => Promise<void>;
  /** Saves `p`, replacing the one of its id. */
  save: (p: Proposal) => Promise<void>;
  /** Makes `p` the person's theme, and puts it on. */
  keep: (p: Proposal) => Promise<void>;
  discard: (id: string) => Promise<void>;
}

const newestFirst = (list: Proposal[]): Proposal[] => [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

/** The most proposals kept: a newer one drops the oldest. */
export const MOST_PROPOSALS = 20;

export const useProposals = create<ProposalsState>((set, get) => ({
  list: [],
  loaded: false,
  load: async () => {
    const list = (await proposalFiles()).flatMap((f) => {
      try {
        return [parseProposal(f.id, f.source)];
      } catch (e) {
        if (e instanceof ThemeError) console.warn(`theme proposal ${f.id}: ${e.message}`);
        return [];
      }
    });
    set({ list: newestFirst(list), loaded: true });
  },
  save: async (p) => {
    await writeProposal(p.spec.id, serializeProposal(p));
    // The one just saved always stays, whatever its hub's clock says.
    const others = newestFirst(get().list.filter((x) => x.spec.id !== p.spec.id));
    for (const old of others.slice(MOST_PROPOSALS - 1)) await removeProposal(old.spec.id).catch(() => undefined);
    set({ list: newestFirst([p, ...others.slice(0, MOST_PROPOSALS - 1)]) });
  },
  keep: async (p) => {
    // A proposal that changes one of the person's themes is kept as it;
    // a new one never as a theme the person made since it was proposed.
    const taken = allThemes(useThemeStore.getState().custom).map((t) => t.id);
    const id = p.revises ?? (taken.includes(p.spec.id) ? freeId(p.spec.name, taken) : p.spec.id);
    const spec: ThemeSpec = { ...p.spec, id };
    await writeTheme(id, serializeTheme(spec));
    await removeProposal(p.spec.id);
    set({ list: get().list.filter((x) => x.spec.id !== p.spec.id) });
    const themes = useThemeStore.getState();
    themes.setCustom([...themes.custom.filter((t) => t.id !== id), spec]);
    themes.setChoice(id);
  },
  discard: async (id) => {
    await removeProposal(id);
    set({ list: get().list.filter((x) => x.spec.id !== id) });
  },
}));

/** A call of `theme.*`, as a hub hands it to Desk. */
export interface ThemeJob {
  id: string;
  kind: "current" | "propose" | "revise";
  agent: string;
  session?: string | null;
  input: unknown;
  at: string;
}

/** The theme the person has on now. */
const current = (): ThemeSpec => {
  const { choice, custom, systemDark } = useThemeStore.getState();
  return resolveTheme(choice, custom, systemDark).spec;
};

const summary = (spec: ThemeSpec) => {
  const t = derive(spec);
  return { id: spec.id, name: spec.name, dark: t.dark, background: t.colors.bg, signal: t.colors.signal, text: t.colors.text };
};

/** What the agent is told of a proposal it made. */
const told = (p: Proposal) => ({
  ...summary(p.spec),
  ...(p.revises ? { revises: p.revises } : {}),
  saved: "as a proposal: nothing changes until the person keeps it, on its card in this conversation or in Settings",
  moved: p.changes.length ? p.changes : "nothing: every pair Desk checks reads",
});

/** Desk's answer to `job` from hub `hub`: the tool's result, or why not. A
 *  proposal is only ever saved as a proposal, in the themes folder. */
export const answerJob = (hub: string, job: ThemeJob): Promise<{ ok: boolean; body: unknown }> => {
  // One at a time, across every hub: two proposals never take one id.
  const next = queue.then(() => answer(hub, job));
  queue = next.catch(() => undefined);
  return next;
};

let queue: Promise<unknown> = Promise.resolve();

/** When the hub asked: the chat's messages are on its clock. */
const askedAt = (job: ThemeJob): string => (Number.isNaN(Date.parse(job.at)) ? new Date().toISOString() : new Date(Date.parse(job.at)).toISOString());

const answer = async (hub: string, job: ThemeJob): Promise<{ ok: boolean; body: unknown }> => {
  try {
    if (!useProposals.getState().loaded) await useProposals.getState().load();
    const { custom } = useThemeStore.getState();
    const proposals = useProposals.getState().list;
    if (job.kind === "current") {
      const spec = current();
      const t = derive(spec);
      return {
        ok: true,
        body: {
          ...summary(spec),
          builtin: BUILTIN.some((b) => b.id === spec.id),
          overrides: spec.overrides,
          density: spec.density,
          corners: spec.corners,
          colors: Object.fromEntries(TOKENS.map((k) => [k, t.colors[k]])),
          themes: allThemes(custom).map((s) => ({ id: s.id, name: s.name, dark: derive(s).dark, builtin: BUILTIN.some((b) => b.id === s.id) })),
          proposals: proposals.map((p) => ({ id: p.spec.id, name: p.spec.name, ...(p.revises ? { revises: p.revises } : {}) })),
        },
      };
    }
    const at = askedAt(job);
    const from = { hub, agent: job.agent, ...(job.session ? { session: job.session } : {}) };
    if (job.kind === "propose") {
      const input = parsePropose(job.input);
      const taken = [...allThemes(custom).map((t) => t.id), ...proposals.map((p) => p.spec.id)];
      const made = propose(input, current(), taken);
      const p: Proposal = { spec: made.spec, ...from, changes: made.changes, nudged: made.nudged, at, ...(input.reason ? { reason: input.reason } : {}) };
      await useProposals.getState().save(p);
      return { ok: true, body: told(p) };
    }
    const input = parseRevise(job.input);
    const proposal = proposals.find((p) => p.spec.id === input.theme);
    if (proposal) {
      const made = revise(proposal.spec, input, proposal);
      const p: Proposal = { ...proposal, ...from, spec: made.spec, changes: made.changes, nudged: made.nudged, at, ...(input.reason ? { reason: input.reason } : {}) };
      await useProposals.getState().save(p);
      return { ok: true, body: told(p) };
    }
    if (RESERVED_IDS.includes(input.theme))
      throw new ThemeError(`"${input.theme}" is one of Desk's own themes, which can't be changed: propose a new one from its colours (theme.current)`);
    const theirs = custom.find((t) => t.id === input.theme);
    if (!theirs) throw new ThemeError(`there is no theme or proposal "${input.theme}": theme.current lists them`);
    const made = revise(theirs, input);
    const p: Proposal = { spec: made.spec, revises: theirs.id, ...from, changes: made.changes, nudged: made.nudged, at, ...(input.reason ? { reason: input.reason } : {}) };
    await useProposals.getState().save(p);
    return { ok: true, body: told(p) };
  } catch (e) {
    return { ok: false, body: { error: e instanceof Error ? e.message : String(e) } };
  }
};

/** How long after its start a turn's proposals may come, on the newest
 *  message. */
const TURN_MOST_MS = 15 * 60_000;

/** The proposals hub `hub`'s agent `agent` made between `since` and
 *  `until` (ISO; a few seconds either side), for the card in its chat. */
export const proposalsFrom = (list: readonly Proposal[], hub: string, agent: string, since?: string, until?: string): Proposal[] => {
  const slack = 5000;
  const from = since ? Date.parse(since) - slack : -Infinity;
  // The newest message has no next one: its turn's, not every later one.
  const to = until ? Date.parse(until) + slack : since ? Date.parse(since) + TURN_MOST_MS : Infinity;
  return list.filter((p) => p.hub === hub && p.agent === agent && Date.parse(p.at) >= from && Date.parse(p.at) <= to);
};
