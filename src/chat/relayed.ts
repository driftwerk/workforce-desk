import type { ChatMessage } from "./types";

/** A turn in a DM that the overseer sent on: the hub delivers it as the
 *  person's own message, worded "<name> asks: …" or "<name> has a task for
 *  you: …", where the name is the overseer's, or the person's (or "You" on
 *  older hubs) for a suggestion of its that they said yes to. */
export interface Relayed {
  /** Who it's from: the overseer itself, or you (by saying yes). */
  by: "overseer" | "you";
  /** The overseer it came through, by name. */
  overseer: string;
  task: boolean;
  /** What it says, without the wording around it. */
  text: string;
}

const ASKS = " asks: ";
const TASK = " has a task for you: ";

/** What the hub calls the person when it doesn't know their name. */
export const NO_NAME = "The person you work for";

/** `content` without the wording `name` sent it with, if it has it. */
const worded = (content: string, name: string): { task: boolean; text: string } | null => {
  for (const [said, task] of [
    [ASKS, false],
    [TASK, true],
  ] as const) {
    const prefix = `${name}${said}`;
    if (!content.startsWith(prefix)) continue;
    const text = content.slice(prefix.length);
    if (text.trim()) return { task, text };
  }
  return null;
};

/** `content` without the wording of whoever sent it: after whichever of
 *  " asks: " and " has a task for you: " comes first. */
const anyWording = (content: string): { task: boolean; text: string } => {
  const asks = content.indexOf(ASKS);
  const task = content.indexOf(TASK);
  const isTask = task >= 0 && (asks < 0 || task < asks);
  const at = isTask ? task : asks;
  const text = at < 0 ? content : content.slice(at + (isTask ? TASK : ASKS).length);
  return text.trim() ? { task: isTask, text } : { task: false, text: content };
};

/** The relayed turn `content` is, if it is one, told only by its wording
 *  (for messages kept before the hub said who sent them). `crew` names
 *  everyone on the hub who could have been overseeing when it was sent
 *  (names and ids: the hub falls back to the id); `overseer` is who
 *  oversees now, for a suggestion you said yes to; `person` is your name on
 *  the hub, if Desk knows it. */
export const relayedTurn = (
  content: string,
  crew: readonly string[],
  overseer: string | null,
  person: string | null = null,
): Relayed | null => {
  const yours = [...new Set(["You", NO_NAME, person?.trim() ?? ""].filter(Boolean))];
  const names = [...new Set(crew.filter((n) => n.trim()))].sort((a, b) => b.length - a.length);
  for (const name of [...yours, ...names]) {
    const said = worded(content, name);
    if (!said) continue;
    if (yours.includes(name)) return { by: "you", overseer: overseer ?? "the overseer", ...said };
    return { by: "overseer", overseer: name, ...said };
  }
  return null;
};

/** Where `m` came from, if the overseer sent it on. Who said it is taken
 *  from the hub where it says (`m.author`); where it doesn't (an older hub,
 *  or a message kept before), and only on this Mac (`local`), from its
 *  wording. */
export const relayedOf = (
  m: ChatMessage,
  ctx: { local: boolean; crew: readonly string[]; overseer: string | null; person: string | null },
): Relayed | null => {
  if (m.role !== "user") return null;
  if (m.author?.kind === "overseer") {
    const name = m.author.name || m.author.id || "the overseer";
    return { by: "overseer", overseer: name, ...(worded(m.content, name) ?? anyWording(m.content)) };
  }
  if (m.author && m.author.kind !== "you") return null;
  // Sent live, not typed here: a suggestion you said yes to.
  const yes = (): Relayed => {
    const yours = [ctx.person?.trim() ?? "", NO_NAME, "You"].filter(Boolean);
    const said = yours.map((n) => worded(m.content, n)).find(Boolean) ?? anyWording(m.content);
    return { by: "you", overseer: ctx.overseer ?? "the overseer", ...said };
  };
  if (m.sentOn && m.author) return yes();
  const byWording = ctx.local || m.sentOn ? relayedTurn(m.content, ctx.crew, ctx.overseer, ctx.person) : null;
  return byWording ?? (m.sentOn ? yes() : null);
};
