import { parse, stringify } from "smol-toml";
import type { DeskHub } from "../hub/client";
import type { Listing } from "../hub/connections";

/** Which connectors reach an agent, as its own `config.toml` says:
 *
 *  ```toml
 *  [skills]
 *  enabled        = ["linear", "github"]  # only these connectors' tools reach it
 *  read_only      = ["github"]            # their write tools are hidden too
 *  own_credential = ["linear"]            # its own connection; the rest use mine
 *  ```
 *
 *  No `enabled` at all is every connector, as before Desk chose any: an
 *  agent nobody has chosen connectors for keeps what it had. `enabled = []`
 *  is none, which is how a new agent starts. */
export interface Binding {
  /** Null: every connector reaches it. */
  enabled: string[] | null;
  readOnly: string[];
  own: string[];
}

/** How a connector reaches an agent: not at all, through the person's
 *  connection for all their agents, or through one just for this agent. */
export type Through = "off" | "mine" | "own";

type Doc = Record<string, unknown>;

const table = (v: unknown): Doc =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {};
const names = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;

const parseDoc = (source: string): Doc => {
  try {
    return source.trim() ? (parse(source) as Doc) : {};
  } catch {
    return {};
  }
};

export const bindingOf = (source: string): Binding => {
  const skills = table(parseDoc(source).skills);
  return {
    enabled: names(skills.enabled),
    readOnly: names(skills.read_only) ?? [],
    own: names(skills.own_credential) ?? [],
  };
};

/** Whether connector `id` reaches the agent, and through whose connection. */
export const throughOf = (b: Binding, id: string): Through =>
  b.enabled !== null && !b.enabled.includes(id)
    ? "off"
    : b.own.includes(id)
      ? "own"
      : "mine";

const without = (list: string[], id: string) => list.filter((x) => x !== id);
const sorted = (list: string[]) => [...new Set(list)].sort();

/** What reaches an agent nobody has chosen connectors for: every connector
 *  the hub has, and the ones it reaches through its own connection. */
export interface Today {
  reaching: string[];
  own: string[];
}

/** What reaches agent `agent` today by `listing`, as a first choice must
 *  keep it: the catalog's connectors, every other adapter the hub has, and
 *  the ones it reaches through its own connection. */
export const todayOf = (listing: Listing | null, agent: string): Today => {
  const list = listing?.connectors;
  if (!list) return { reaching: [], own: [] };
  return {
    reaching: [...new Set([...list.map((c) => c.id), ...(listing.adapters ?? [])])],
    own: list.filter((c) => c.usedBy.some((u) => u.agent === agent && u.connection === "own")).map((c) => c.id),
  };
};

/** `b` as written once the person first chooses: an agent with no
 *  `enabled` yet gets what reaches it today, so choosing one changes
 *  nothing about the rest. */
const chosen = (b: Binding, today: Today): Binding =>
  b.enabled !== null ? b : { enabled: sorted(today.reaching), readOnly: b.readOnly, own: sorted([...b.own, ...today.own]) };

/** `b` with `id` reaching the agent `through`. */
export const choose = (b: Binding, id: string, through: Through, today: Today): Binding => {
  const c = chosen(b, today);
  const enabled = c.enabled ?? [];
  return {
    enabled: sorted(through === "off" ? without(enabled, id) : [...enabled, id]),
    readOnly: through === "off" ? without(c.readOnly, id) : c.readOnly,
    own: sorted(through === "own" ? [...c.own, id] : without(c.own, id)),
  };
};

/** `b` with `id`'s writes allowed or not. */
export const allowWrites = (b: Binding, id: string, writes: boolean, today: Today): Binding => {
  const c = chosen(b, today);
  return { ...c, readOnly: sorted(writes ? without(c.readOnly, id) : [...c.readOnly, id]) };
};

/** The config with `b` as its `[skills]`; anything else in it stays. */
export const withBinding = (source: string, b: Binding): string => {
  const doc = (source.trim() ? parse(source) : {}) as Doc;
  const skills: Doc = { ...table(doc.skills) };
  if (b.enabled === null) delete skills.enabled;
  else skills.enabled = b.enabled;
  if (b.readOnly.length > 0) skills.read_only = b.readOnly;
  else delete skills.read_only;
  if (b.own.length > 0) skills.own_credential = b.own;
  else delete skills.own_credential;
  if (Object.keys(skills).length > 0) doc.skills = skills;
  else delete doc.skills;
  return stringify(doc).trim() + "\n";
};

/** How an agent's connector writes go, as its `[computer]` says: below
 *  Full access they ask first; at Full access only what sends to people
 *  asks (the default), or nothing ("do anything"). */
export type Writes = "ask" | "sends_ask" | "own";

export const writesOf = (source: string): Writes => {
  const computer = table(parseDoc(source).computer);
  const access = typeof computer.access === "string" ? computer.access : "full";
  if (access !== "full") return "ask";
  return computer.asks === "never" ? "own" : "sends_ask";
};

/** What an agent at Full access asks about first, as its `[computer]`
 *  says: what can't be undone and sends to people (the default), or
 *  nothing. */
export const asksOf = (source: string): "irreversible" | "never" =>
  table(parseDoc(source).computer).asks === "never" ? "never" : "irreversible";

/** Writes `change` of the agent's connectors into its config as it is now
 *  (read fresh, so nothing else in it is lost); the config as written. */
export async function setAgentConnectors(
  hub: DeskHub,
  id: string,
  change: (b: Binding) => Binding,
): Promise<string> {
  const source = await hub.agentConfig(id);
  if (source.trim()) {
    try {
      parse(source);
    } catch {
      throw new Error(
        "Their settings file has a mistake in it, so Desk won’t change it.",
      );
    }
  }
  const toml = withBinding(source, change(bindingOf(source)));
  await hub.saveAgentConfig(id, toml);
  return toml;
}
