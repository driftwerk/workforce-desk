import type { ConversationState } from "../chat/conversation";
import { finishedAnswers } from "../chat/conversation";
import { agentKey, FEATURES, type Agent, type ChatMessage } from "../chat/types";
import type { VoiceSpec } from "../platform";
import type { RosterMember } from "./api";
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

/** The answers that finished in this update of a conversation, given it was
 *  being waited on since `since` (ms): one that was already under way when the
 *  wait began counts; history brought in meanwhile isn't anything finishing. */
export const newAnswers = (before: ConversationState, after: ConversationState, since: number): ChatMessage[] => {
  const known = new Set(before.messages.map((m) => m.id));
  return finishedAnswers(before, after).filter((m) => known.has(m.id) || !m.at || Date.parse(m.at) >= since);
};

/** What a failed turn said, if this update brought one. */
export const failureIn = (before: ConversationState, after: ConversationState): string | null => {
  const known = new Set(before.messages.map((m) => m.id));
  return after.messages.find((m) => !known.has(m.id) && m.status === "error")?.content ?? null;
};

/** What's being waited on when a wait begins, to tell later what's its own. */
export interface Asked {
  turns: ReadonlySet<string>;
  absorbed: number;
}

export const asked = (s: ConversationState | undefined): Asked => ({
  turns: new Set(Object.keys(s?.turns ?? {})),
  absorbed: s?.absorbed ?? 0,
});

/** Whether this update ended what was said to the agent. The hub sends an
 *  answer's parts as separate streams, a line before a tool and the answer
 *  after it, so nothing but the turn's end says it's over. A thing said while
 *  a turn runs is absorbed into that turn, whose frames carry on, and gets none
 *  of its own; one that isn't starts its own, not ended yet. */
export const turnsOver = (before: ConversationState, after: ConversationState, since: Asked): boolean => {
  const turns = Object.values(after.turns);
  const ended = turns.some((t) => (t.state === "ended" || t.state === "failed") && before.turns[t.ref]?.state !== t.state);
  if (!ended) return false;
  const going = turns.filter((t) => t.state === "live" || t.state === "stalled");
  if (going.some((t) => t.acked)) return false;
  return going.filter((t) => !since.turns.has(t.ref)).length <= after.absorbed - since.absorbed;
};

/** Whether this conversation's hub says when turns end. */
export const saysWhenTurnsEnd = (s: ConversationState): boolean => !!s.features?.has(FEATURES.stream);

/** An agent's answer for a voice model to relay: formatting dropped, code left
 *  on screen, all of it. */
export const forModel = (answer: string): string => speakable(answer);

/** What a voice model hears when the agent it named isn't on the roster. */
export const missingAgent = (named: string | null, roster: string[]): string =>
  named
    ? `There's no agent called ${named}.${roster.length ? ` The agents are ${roster.join(", ")}.` : ""}`
    : "I'm not sure who that's for.";

/** Providers the cascade speaks answers with; the live engines' voices are
 *  only heard in their own sessions. */
const SPOKEN = new Set(["kokoro", "fish_audio", "elevenlabs", "openai"]);
const LIVE = new Set(["gpt-live", "gemini-live"]);

/** The voice an agent's answer is read in: its own, else Desk's default. */
export const voiceFor = (agent: Agent, agentVoices: Record<string, VoiceSpec>, defaultVoice: VoiceSpec): VoiceSpec => {
  const own = agentVoices[agentKey(agent)];
  return own && SPOKEN.has(own.provider) ? own : defaultVoice;
};

/** Who to wake on, each name once, with the live voice its agent has. */
export const voiceRoster = (roster: Agent[], agentVoices: Record<string, VoiceSpec>): RosterMember[] =>
  wakeNames(roster).map((name) => {
    const voice = roster
      .filter((a) => a.name === name)
      .map((a) => agentVoices[agentKey(a)])
      .find((v) => v && LIVE.has(v.provider));
    return voice ? { name, voice } : { name };
  });

/** The voice an answer is heard in, as a turn tells the hub: the agent's
 *  own (or Desk's default) when Desk reads it, the live engine when a
 *  cloud voice model relays it. */
export const speechOf = (spec: VoiceSpec): { provider: string; model?: string } =>
  spec.model ? { provider: spec.provider, model: spec.model } : { provider: spec.provider };
