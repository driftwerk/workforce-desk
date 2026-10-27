import { parse, stringify } from "smol-toml";
import type { DeskHub } from "../hub/client";

/** The plans an agent on this Mac can run on. */
export type Plan = "claude" | "chatgpt";

export const PLAN_PROVIDER: Record<Plan, string> = { claude: "claude-code", chatgpt: "chatgpt" };

/** Vault paths that hold each plan's login. */
export const PLAN_LOGIN: Record<Plan, string> = { claude: "claude_code/oauth_token", chatgpt: "codex/auth_json" };

const RICH = { tables: true, charts: true, forms: true, maps: true, diagrams: true, images: true };

/** "Release Captain" → "release-captain", unique among `taken`. */
export const agentId = (name: string, taken: readonly string[]): string => {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "agent";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
};

/** The instructions an agent starts with: its name and the person's own
 *  words for what it's for. */
export const instructions = (name: string, purpose: string): string =>
  `You are ${name}, one of the agents the person works with in Desk.\n\nWhat you are for, in their words:\n${purpose.trim()}`;

const PURPOSE_HEADING = "## What You're For";

/** SOUL.md with a section saying who the agent is and what it's for, placed
 *  first so it frames the rest; an earlier one is replaced. */
export const withPurpose = (soul: string, name: string, purpose: string): string => {
  const section = `${PURPOSE_HEADING}\n\nYou are ${name}. Your human set you up for this, in their words:\n\n${purpose
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n")}\n\nThat is your job. Everything below is how you go about it.\n`;
  const without = soul.replace(new RegExp(`${PURPOSE_HEADING}\\n[\\s\\S]*?(?=\\n## |$)`), "").trimEnd();
  const firstSection = without.search(/\n## /);
  return firstSection < 0
    ? `${without}\n\n${section}`
    : `${without.slice(0, firstSection)}\n\n${section}${without.slice(firstSection)}\n`;
};

/** IDENTITY.md with the agent's name filled in. */
export const withName = (identity: string, name: string): string =>
  /\*\*Name:\*\*/.test(identity) ? identity.replace(/(\*\*Name:\*\*)[^\n]*/, `$1 ${name}`) : `- **Name:** ${name}\n${identity}`;

/** The plan to use: the chosen one, else whichever plan is connected
 *  (Claude first). */
export const pickPlan = (chosen: Plan | null, connected: readonly string[]): Plan => {
  if (chosen) return chosen;
  return connected.includes(PLAN_LOGIN.chatgpt) && !connected.includes(PLAN_LOGIN.claude) ? "chatgpt" : "claude";
};

/** An agent's config with Desk's settings in it: the plan, the standard
 *  model of that plan, and every rich block on. Anything else in the file
 *  stays. */
export const withDeskSettings = (source: string, plan: Plan): string => {
  const doc = (source.trim() ? parse(source) : {}) as Record<string, unknown>;
  const llm = (doc.llm ?? {}) as Record<string, unknown>;
  doc.llm = { ...llm, provider: PLAN_PROVIDER[plan], default_model: "standard" };
  doc.rich = { ...RICH, ...((doc.rich as object | undefined) ?? {}) };
  return stringify(doc) + "\n";
};

export async function createLocalAgent(
  hub: DeskHub,
  name: string,
  purpose: string,
  plan: Plan,
  taken: readonly string[],
): Promise<string> {
  const id = agentId(name, taken);
  await hub.createAgent({ id, name: name.trim(), system_prompt: instructions(name.trim(), purpose) });
  await hub.saveAgentConfig(id, withDeskSettings(await hub.agentConfig(id), plan));
  await hub.saveIdentityFile(id, "SOUL.md", withPurpose(await hub.identityFile(id, "SOUL.md"), name.trim(), purpose));
  await hub.saveIdentityFile(id, "IDENTITY.md", withName(await hub.identityFile(id, "IDENTITY.md"), name.trim()));
  return id;
}

/** Points every agent on this Mac at a plan, taking effect on its next turn. */
export async function applyPlan(hub: DeskHub, agentIds: readonly string[], plan: Plan): Promise<void> {
  for (const id of agentIds) await hub.saveAgentConfig(id, withDeskSettings(await hub.agentConfig(id), plan));
}
