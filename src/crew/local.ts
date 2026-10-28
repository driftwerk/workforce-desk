import { HubError, type DeskHub } from "../hub/client";
import { withBrain, withDeskSettings, type Brain } from "./brain";
import { withVoice } from "./voice";

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

const quote = (text: string): string =>
  text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `doc` with `## heading` and `body` as its first section (after any
 *  title); an earlier section of that heading is replaced. */
const withSection = (doc: string, heading: string, body: string): string => {
  const section = `## ${heading}\n\n${body}\n`;
  const without = doc.replace(new RegExp(`## ${escape(heading)}\\n[\\s\\S]*?(?=\\n## |$)`), "").trimEnd();
  const firstSection = without.search(/\n## /);
  if (!without) return section;
  return firstSection < 0
    ? `${without}\n\n${section}`
    : `${without.slice(0, firstSection)}\n\n${section}${without.slice(firstSection)}\n`;
};

const PURPOSE = "What You're For";

/** SOUL.md with a section saying who the agent is and what it's for, placed
 *  first so it frames the rest; an earlier one is replaced. */
export const withPurpose = (soul: string, name: string, purpose: string): string =>
  withSection(
    soul,
    PURPOSE,
    `You are ${name}. Your human set you up for this, in their words:\n\n${quote(purpose)}\n\nThat is your job. Everything below is how you go about it.`,
  );

/** What the agent is for, in the person's words, as SOUL.md says it. */
export const purposeOf = (soul: string): string => {
  const section = soul.match(new RegExp(`## ${escape(PURPOSE)}\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1] ?? "";
  return section
    .split("\n")
    .filter((l) => l.startsWith(">"))
    .map((l) => l.replace(/^> ?/, ""))
    .join("\n")
    .trim();
};

/** AGENTS.md with the agent's job first, so its working rules serve it; the
 *  hub's own guidelines below stay. */
export const withJob = (agents: string, name: string, purpose: string): string =>
  withSection(
    agents,
    "Your Job",
    `As ${name}, your work is this, in your human's words:\n\n${quote(purpose)}\n\nWhen something you're asked falls outside it, help anyway, and say so if it matters.`,
  );

const GREETING = /^Greet them as [^\n]*\n?/m;

/** WELCOME.md (an instruction for the first message of a chat) opening by
 *  saying who the agent is and what it's for. */
export const withWelcome = (welcome: string, name: string, purpose: string): string =>
  `Greet them as ${name}, and say in one sentence what you're here for: ${purpose.trim().replace(/\s+/g, " ")}\n${welcome.replace(GREETING, "")}`;

/** IDENTITY.md with the agent's name filled in. */
export const withName = (identity: string, name: string): string =>
  /\*\*Name:\*\*/.test(identity) ? identity.replace(/(\*\*Name:\*\*)[^\n]*/, `$1 ${name}`) : `- **Name:** ${name}\n${identity}`;

const rewrite = async (hub: DeskHub, id: string, file: string, change: (text: string) => string): Promise<void> => {
  const text = await hub.identityFile(id, file);
  // A missing AGENTS.md means the hub's own guidelines apply; writing only
  // the job would replace them.
  if (file === "AGENTS.md" && !text.trim()) return;
  await hub.saveIdentityFile(id, file, change(text));
};

/** A new agent on this Mac, thinking with `brain`, with its files written
 *  from its name and what it's for. */
export async function createLocalAgent(
  hub: DeskHub,
  name: string,
  purpose: string,
  brain: Brain,
  taken: readonly string[],
): Promise<string> {
  const id = agentId(name, taken);
  const who = name.trim();
  await hub.createAgent({ id, name: who, system_prompt: instructions(who, purpose) });
  await hub.saveAgentConfig(id, withDeskSettings(await hub.agentConfig(id), brain));
  await rewrite(hub, id, "SOUL.md", (t) => withPurpose(t, who, purpose));
  await rewrite(hub, id, "AGENTS.md", (t) => withJob(t, who, purpose));
  await rewrite(hub, id, "IDENTITY.md", (t) => withName(t, who));
  await rewrite(hub, id, "WELCOME.md", (t) => withWelcome(t, who, purpose));
  return id;
}

/** A new description of what an agent is for, in every file that says it
 *  and in its instructions (a hub that can't update those keeps the old). */
export async function setAgentPurpose(hub: DeskHub, id: string, name: string, purpose: string): Promise<void> {
  try {
    await hub.renameAgent(id, name.trim(), instructions(name.trim(), purpose));
  } catch (e) {
    if (!(e instanceof HubError && (e.status === 404 || e.status === 405))) throw e;
  }
  await rewrite(hub, id, "SOUL.md", (t) => withPurpose(t, name, purpose));
  await rewrite(hub, id, "AGENTS.md", (t) => withJob(t, name, purpose));
  await rewrite(hub, id, "WELCOME.md", (t) => withWelcome(t, name, purpose));
}

/** Said when the hub can't rename agents yet. */
export const RENAME_UNAVAILABLE = "Renaming isn’t available yet: Desk needs an update first. Their name is unchanged.";

/** Renames an agent on the hub, its instructions included when Desk knows
 *  what it's for (`purpose`, or what SOUL.md says). */
export async function renameLocalAgent(hub: DeskHub, id: string, name: string, purpose?: string): Promise<void> {
  const who = name.trim();
  const job = purpose?.trim() || purposeOf(await hub.identityFile(id, "SOUL.md").catch(() => ""));
  try {
    await hub.renameAgent(id, who, job ? instructions(who, job) : undefined);
  } catch (e) {
    if (e instanceof HubError && (e.status === 404 || e.status === 405)) throw new Error(RENAME_UNAVAILABLE);
    throw e;
  }
}

/** Puts an agent's new name in every file that says it: IDENTITY.md, and
 *  the sections Desk wrote from what it's for (`purpose`, or what SOUL.md
 *  says when not given). */
export async function renameAgentFiles(hub: DeskHub, id: string, name: string, purpose?: string): Promise<void> {
  const who = name.trim();
  await rewrite(hub, id, "IDENTITY.md", (t) => withName(t, who));
  const job = purpose?.trim() || purposeOf(await hub.identityFile(id, "SOUL.md"));
  if (job) await setAgentPurpose(hub, id, who, job);
}

/** Writes `brain` to the agent's config; answers with the config as written. */
export async function setAgentBrain(hub: DeskHub, id: string, brain: Brain): Promise<string> {
  const toml = withBrain(await hub.agentConfig(id), brain);
  await hub.saveAgentConfig(id, toml);
  return toml;
}

export async function setAgentVoice(hub: DeskHub, id: string, voice: { provider: string; model?: string; voice?: string }): Promise<void> {
  await hub.saveAgentConfig(id, withVoice(await hub.agentConfig(id), voice));
}
