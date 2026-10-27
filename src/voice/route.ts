import type { ConversationState } from "../chat/conversation";
import { finishedAnswers } from "../chat/conversation";
import { agentKey, type Agent } from "../chat/types";
import { speakable } from "./speakable";

/** The roster names to wake on, each once. */
export const wakeNames = (roster: Agent[]): string[] => [...new Set(roster.map((a) => a.name))];

/** Who an utterance is for: the agent it named (local first when two hubs
 *  share a name), else the one already being talked to, else the open DM. */
export const resolveAgent = (
  named: string | null,
  roster: Agent[],
  current: Agent | null,
  activeKey: string | null,
): Agent | null => {
  if (named) {
    const matches = roster.filter((a) => a.name === named);
    return matches.find((a) => a.hubId === "local") ?? matches.find((a) => current && agentKey(a) === agentKey(current)) ?? matches[0] ?? null;
  }
  return current ?? roster.find((a) => agentKey(a) === activeKey) ?? null;
};

/** What to say while a slow answer is on its way. */
export const acknowledgement = (name: string, turn: number): string =>
  [`On it.`, `${name}'s on it.`, `Working on it.`][turn % 3]!;

export type Outcome = { kind: "answer"; text: string } | { kind: "error"; text: string };

/** What a conversation update means for a spoken turn: an answer finished,
 *  or the hub reported an error. */
export const outcome = (before: ConversationState, after: ConversationState): Outcome | null => {
  const answer = finishedAnswers(before, after).at(-1);
  if (answer) return { kind: "answer", text: answer.content };
  const known = new Set(before.messages.map((m) => m.id));
  const failure = after.messages.find((m) => !known.has(m.id) && m.status === "error");
  return failure ? { kind: "error", text: failure.content } : null;
};

/** Enough of an agent's answer for a voice model to relay: formatting
 *  dropped, code left on screen, longer than what Desk reads aloud itself. */
export const forModel = (answer: string): string => speakable(answer, 1_500);

/** What a voice model hears when the agent it named isn't on the roster. */
export const missingAgent = (named: string | null, roster: string[]): string =>
  named
    ? `There's no agent called ${named}.${roster.length ? ` The agents are ${roster.join(", ")}.` : ""}`
    : "I'm not sure who that's for.";
