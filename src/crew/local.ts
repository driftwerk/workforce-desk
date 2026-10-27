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

type Doc = Record<string, unknown>;

const parseDoc = (source: string): Doc => (source.trim() ? (parse(source) as Doc) : {});

/** An agent's config with Desk's settings in it: the plan, a model of that
 *  plan (its standard tier unless named), and every rich block on. Anything
 *  else in the file stays. */
export const withDeskSettings = (source: string, plan: Plan, model = "standard"): string => {
  const doc = parseDoc(source);
  const llm = (doc.llm ?? {}) as Doc;
  doc.llm = { ...llm, provider: PLAN_PROVIDER[plan], default_model: model };
  doc.rich = { ...RICH, ...((doc.rich as object | undefined) ?? {}) };
  return stringify(doc) + "\n";
};

/** Voice providers the hub speaks with too (voice notes, clips). */
const HUB_SPEECH = new Set(["fish_audio", "elevenlabs", "openai"]);

/** An agent's config speaking with `voice` wherever the hub speaks for it;
 *  a voice the hub can't use (Kokoro, the live engines) leaves it on the
 *  hub's default. */
export const withVoice = (source: string, voice: { provider: string; model?: string; voice?: string }): string => {
  const doc = parseDoc(source);
  const llm = { ...((doc.llm ?? {}) as Doc) };
  if (HUB_SPEECH.has(voice.provider)) {
    llm.speech = Object.fromEntries(
      Object.entries({ provider: voice.provider, model: voice.model, voice: voice.voice }).filter(([, v]) => v !== undefined),
    );
  } else delete llm.speech;
  doc.llm = llm;
  return stringify(doc) + "\n";
};

/** The plan and model an agent's config is on. */
export const planOf = (source: string): { plan: Plan | null; model: string | null } => {
  const llm = (parseDoc(source).llm ?? {}) as Doc;
  const plan = (Object.keys(PLAN_PROVIDER) as Plan[]).find((p) => PLAN_PROVIDER[p] === llm.provider) ?? null;
  return { plan, model: typeof llm.default_model === "string" ? llm.default_model : null };
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

export async function setAgentModel(hub: DeskHub, id: string, plan: Plan, model: string): Promise<void> {
  await hub.saveAgentConfig(id, withDeskSettings(await hub.agentConfig(id), plan, model));
}

export async function setAgentVoice(hub: DeskHub, id: string, voice: { provider: string; model?: string; voice?: string }): Promise<void> {
  await hub.saveAgentConfig(id, withVoice(await hub.agentConfig(id), voice));
}
