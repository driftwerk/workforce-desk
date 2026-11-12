import { HubError, type DeskHub } from "../hub/client";
import { withBrain, withDeskSettings, type Brain } from "./brain";
import { withVoice } from "./voice";
import { withDeskWelcome } from "./welcome";

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

/** Said when another agent on the same hub has the name. */
export const NAME_TAKEN = "That name is taken.";

/** A name as it reads: its case, spaces and Unicode spelling aside. */
const asRead = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();

/** Whether another agent on hub `hubId` (not `self`, when given) has
 *  `name`, its case and spaces aside: two agents of one name couldn't be
 *  told apart, in a room's @-mentions or anywhere else. */
export const nameTaken = (name: string, roster: readonly { hubId: string; id: string; name?: string }[], hubId: string, self?: string): boolean => {
  const said = asRead(name);
  return !!said && roster.some((a) => a.hubId === hubId && a.id !== self && asRead(a.name ?? "") === said);
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

/** Setting a new crew member up didn't finish: the step that failed, and
 *  why, for Details. `left` names what Desk made and couldn't remove again
 *  (null: nothing of them was kept). */
export class NotSetUp extends Error {
  constructor(
    readonly who: string,
    readonly cause: unknown,
    readonly left: string | null = null,
  ) {
    super(
      left
        ? `Desk couldn’t finish setting up ${who}, nor remove what it had made: “${left}” is still on this computer. Remove it from its Settings before trying again.`
        : `Desk couldn’t finish setting up ${who}, so nothing of them was kept.`,
    );
  }
}

/** Ids tried before giving up when each is taken on the hub already. */
const ID_TRIES = 5;

/** A new agent on this computer, thinking with `brain` and sounding like
 *  `voice`, with its files written from its name and what it's for: all of
 *  it, or nothing. Should any step after it was made fail, the agent is
 *  removed again, so no half-made crew member is ever left behind. */
export async function createLocalAgent(
  hub: DeskHub,
  name: string,
  purpose: string,
  brain: Brain,
  taken: readonly string[],
  voice?: { provider: string; model?: string; voice?: string },
): Promise<string> {
  const who = name.trim();
  // The roster may be behind the hub: an id it says is taken goes to the
  // next free one.
  const tried = [...taken];
  let id = agentId(name, tried);
  for (let n = 1; ; n++) {
    try {
      await hub.createAgent({ id, name: who, system_prompt: instructions(who, purpose) });
      break;
    } catch (e) {
      if (!(e instanceof HubError && e.status === 409) || n >= ID_TRIES) throw e;
      tried.push(id);
      id = agentId(name, tried);
    }
  }
  try {
    // One write of its settings: how it thinks and how it sounds.
    const config = withDeskSettings(await hub.agentConfig(id), brain);
    await hub.saveAgentConfig(id, voice ? withVoice(config, voice) : config);
    await rewrite(hub, id, "SOUL.md", (t) => withPurpose(t, who, purpose));
    await rewrite(hub, id, "AGENTS.md", (t) => withJob(t, who, purpose));
    await rewrite(hub, id, "IDENTITY.md", (t) => withName(t, who));
    await rewrite(hub, id, "WELCOME.md", (t) => withWelcome(withDeskWelcome(t), who, purpose));
  } catch (e) {
    const removed = await hub.deleteAgent(id).then(
      () => true,
      () => false,
    );
    throw new NotSetUp(who, e, removed ? null : id);
  }
  return id;
}

/** A file of an agent's, as it is and as a change leaves it. */
interface Change {
  file: string;
  was: string;
  now: string;
}

/** What the files that say an agent's job become, for `who` doing `job`.
 *  A missing AGENTS.md is left missing: the hub's own guidelines apply. */
const jobChanges = async (hub: DeskHub, id: string, who: string, job: string, soul?: string): Promise<Change[]> => {
  const soulWas = soul ?? (await hub.identityFile(id, "SOUL.md"));
  const agents = await hub.identityFile(id, "AGENTS.md");
  const welcome = await hub.identityFile(id, "WELCOME.md");
  return [
    { file: "SOUL.md", was: soulWas, now: withPurpose(soulWas, who, job) },
    ...(agents.trim() ? [{ file: "AGENTS.md", was: agents, now: withJob(agents, who, job) }] : []),
    { file: "WELCOME.md", was: welcome, now: withWelcome(welcome, who, job) },
  ];
};

/** Writes each change that changes something, noting in `written` each
 *  one once it is. */
const write = async (hub: DeskHub, id: string, changes: readonly Change[], written: Change[]): Promise<void> => {
  for (const c of changes) {
    if (c.was === c.now) continue;
    await hub.saveIdentityFile(id, c.file, c.now);
    written.push(c);
  }
};

/** Puts back the files that were written, as far as it can (one never
 *  written is left alone): the error that brought it here is the one
 *  that's said. */
const undo = async (hub: DeskHub, id: string, written: readonly Change[]): Promise<void> => {
  for (const c of written) await hub.saveIdentityFile(id, c.file, c.was).catch(() => undefined);
};

/** A hub too old to take a new name or instructions. */
const cantTake = (e: unknown) => e instanceof HubError && (e.status === 404 || e.status === 405);

/** How long Desk waits for the hub to serve an agent again after a new
 *  name or new instructions, which build it again. */
export const SERVE_AGAIN_MS = 20_000;
/** How long a build may take to begin after the hub took the change. */
export const REBUILD_STARTS_MS = 1_500;
const POLL_MS = 250;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The ids of the agents a hub serves now (the roster's own read): one it
 *  is building again isn't among them until it serves. */
export type Serving = () => Promise<readonly string[]>;

/** Waits until the hub serves agent `id` again after a change that builds
 *  it again: while that runs it isn't listed and its files can't be read,
 *  so the roster read then would lose it. First (for a moment) until it
 *  goes, then until it's back; an agent the hub never builds again (its
 *  default) is simply still there. True once it serves. */
export async function servingAgain(listed: Serving, id: string, within = SERVE_AGAIN_MS): Promise<boolean> {
  const serving = () => listed().then((ids) => ids.includes(id), () => false);
  const start = Date.now();
  while (Date.now() - start < REBUILD_STARTS_MS && (await serving())) await pause(POLL_MS);
  while (Date.now() - start < within) {
    if (await serving()) return true;
    await pause(POLL_MS);
  }
  return false;
}

/** A new description of what an agent is for, in every file that says it
 *  and in its instructions (a hub that can't update those keeps the old).
 *  The files are written first, while the agent serves; the instructions
 *  then build it again, and (given `listed`) this waits until it serves:
 *  false when it didn’t in time. */
export async function setAgentPurpose(hub: DeskHub, id: string, name: string, purpose: string, listed?: Serving): Promise<boolean> {
  const who = name.trim();
  const job = purpose.trim();
  const changes = await jobChanges(hub, id, who, job);
  const written: Change[] = [];
  try {
    // Written as one: a file that fails puts back those written before it.
    await write(hub, id, changes, written);
  } catch (e) {
    await undo(hub, id, written);
    throw e;
  }
  try {
    await hub.renameAgent(id, who, instructions(who, job));
  } catch (e) {
    // A hub that can't take instructions keeps the old: the files say it.
    if (cantTake(e)) return true;
    await undo(hub, id, written);
    throw e;
  }
  return listed ? servingAgain(listed, id) : true;
}

/** Said when the hub can't rename agents yet. */
export const RENAME_UNAVAILABLE = "Renaming isn’t available yet: Desk needs an update first. Their name is unchanged.";

/** Renames an agent on this computer in one go: its new name goes in every
 *  file that says it (IDENTITY.md, and the sections Desk wrote from what
 *  it's for: `purpose`, or what SOUL.md says), then to the hub with the
 *  instructions that say it. Files first, while the agent serves: the new
 *  name builds it again, and while that runs its files can't be read. If
 *  the hub doesn't take the name, the files go back. Given how to read the
 *  agents the hub serves (`listed`), waits until it serves again: false
 *  when it didn’t in time. */
export async function renameLocalAgent(hub: DeskHub, id: string, name: string, purpose?: string, listed?: Serving): Promise<boolean> {
  const who = name.trim();
  const soul = await hub.identityFile(id, "SOUL.md");
  const job = purpose?.trim() || purposeOf(soul);
  const identity = await hub.identityFile(id, "IDENTITY.md");
  const changes: Change[] = [{ file: "IDENTITY.md", was: identity, now: withName(identity, who) }, ...(job ? await jobChanges(hub, id, who, job, soul) : [])];
  const written: Change[] = [];
  try {
    // Written as one: a file that fails puts back those written before it.
    await write(hub, id, changes, written);
  } catch (e) {
    await undo(hub, id, written);
    throw e;
  }
  try {
    await hub.renameAgent(id, who, job ? instructions(who, job) : undefined);
  } catch (e) {
    await undo(hub, id, written);
    throw cantTake(e) ? new Error(RENAME_UNAVAILABLE) : e;
  }
  return listed ? servingAgain(listed, id) : true;
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
