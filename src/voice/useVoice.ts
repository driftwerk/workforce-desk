import { useEffect } from "react";
import { useChat } from "../chat/store";
import { agentKey, type Agent, type DeskVoice } from "../chat/types";
import { useSettings } from "../settings/store";
import { useAppHold, useAppShortcut, useGlobalShortcut } from "../shortcuts/manager";
import {
  claimVoice,
  disableVoice,
  enableVoice,
  onUnheard,
  onSpeechStopped,
  onUtterance,
  onVoiceError,
  onVoiceState,
  pushToTalk,
  setVoiceRoster,
  speak,
  stopSpeaking,
  toolResult,
  voiceStatus,
  type Utterance,
  type VoiceStatus,
} from "./api";
import { targetDm } from "./dms";
import { voiceEngine } from "./engines";
import { claimMode, holdDone, micFailed, owner, pressHold, releaseHold, repliesOver, replyStarted, toggleTalk, useMic } from "./mic";
import type { VoiceSpec } from "../platform";
import { asked, failureIn, forModel, missingAgent, newAnswers, resolveAgent, saysWhenTurnsEnd, speechOf, turnsOver, voiceFor, voiceRoster, wakeNames } from "./route";
import { ERROR_IN_CHAT, speakable } from "./speakable";
import { useVoiceStore } from "./store";

const ANSWER_WAIT_MS = 10 * 60_000;
const SEND_TRIES = 60;
const SEND_RETRY_MS = 150;

const failed = (e: unknown) => useVoiceStore.setState({ error: e instanceof Error ? e.message : String(e) });

/** Where an answer goes: read aloud (the cascade), back to the cloud voice
 *  model that asked, which says it in its own words, or nowhere but the
 *  DM, where it's read. */
interface Reply {
  answer: (text: string) => void;
}

/** An answer on its way to the engine, which is told before it's over. */
let saying = 0;
/** The claim on the way to the engine, if any: what's said next waits for it. */
let claiming: Promise<unknown> | null = null;

/** Read aloud in `voice`, `agent`'s own. An answer to a DM (`held`) keeps the
 *  engine up to say it, starting it again if nobody has the microphone now. */
const aloud = (agent: string | null, voice?: VoiceSpec, held = false): Reply => ({
  answer: (text) => {
    if (!text.trim()) return;
    useVoiceStore.setState({ speakingFor: agent });
    if (held) replyStarted();
    const say = () => {
      saying++;
      void speak(text, voice)
        .catch((e: unknown) => {
          failed(e);
          if (held) repliesOver();
        })
        .finally(() => saying--);
    };
    if (claiming) void claiming.then(say);
    else say();
  },
});

const toModel = (callId: string): Reply => ({
  answer: (text) => void toolResult(callId, text).catch(failed),
});

/** Dictated: the answer is on screen in the DM. */
const inWriting: Reply = { answer: () => undefined };

/** The voice an agent's answers are read in, from Desk's settings. */
const voiceOf = (agent: Agent): VoiceSpec => {
  const { agentVoices, defaultVoice } = useSettings.getState();
  return voiceFor(agent, agentVoices, defaultVoice);
};

/** How `agent` (by key) answers what's said in its DM. */
export const replyOf = (agent: string): "spoken" | "written" =>
  useSettings.getState().writtenReplies.includes(agent) ? "written" : "spoken";

/** Has `agent` answer what's said in its DM aloud or in writing, from now on. */
export const setReply = (agent: string, reply: "spoken" | "written"): void => {
  const { writtenReplies, set } = useSettings.getState();
  const others = writtenReplies.filter((a) => a !== agent);
  set({ writtenReplies: reply === "written" ? [...others, agent] : others });
};

/** Reads `text`, something delivered to be spoken, aloud in `agent`'s voice
 *  while voice is on. */
export const readAloud = (agent: Agent, text: string): void => {
  if (!useSettings.getState().voice || useVoiceStore.getState().status.state === "off") return;
  aloud(agentKey(agent), voiceOf(agent)).answer(speakable(text));
};

/** Agents whose answers aren't wanted aloud any more: stopped, or the
 *  conversation ended. Saying something to them again wants them back. */
const hushed = new Set<string>();

/** Ends `agent`'s spoken conversation: its answers stop being read out,
 *  whatever is left of them. */
export const endConversation = (agent: string): void => {
  hushed.add(agent);
  if (useMic.getState().talk === agent) toggleTalk(agent);
  void stopSpeaking().catch(failed);
};

/** Starts `agent`'s spoken conversation, or ends it. */
export const talkOrEnd = (agent: string): void => {
  if (useMic.getState().talk === agent) endConversation(agent);
  else toggleTalk(agent);
};

/** Hold to talk in `agent`'s DM: the microphone is its until what's said
 *  has gone. */
export const startHold = (agent: string): void => {
  pressHold(agent);
  void pushToTalk(true).catch(failed);
};

export const endHold = (): void => {
  if (!useMic.getState().pressed) return;
  releaseHold();
  void pushToTalk(false).catch(failed);
};

/** Spoken turns: each utterance goes to its agent's DM through the chat
 *  store — the DM holding the microphone's, else the agent it named — and
 *  the answer goes back when it finishes. */
export class Turns {
  private current: Agent | null = null;
  private waiting = new Map<string, () => void>();
  private speaking = false;

  status(s: VoiceStatus) {
    if (s.state === "off" || (s.state === "listening" && s.conversation === null)) this.current = null;
    if (s.state !== "speaking" && useVoiceStore.getState().speakingFor) useVoiceStore.setState({ speakingFor: null });
    if (s.state === "speaking") this.speaking = true;
    else if (this.speaking && saying === 0) {
      this.speaking = false;
      repliesOver();
    }
  }

  /** What was being read out was stopped: the rest of those answers aren't
   *  wanted, unless something more is said to the agent. */
  stopped() {
    for (const key of this.waiting.keys()) hushed.add(key);
  }

  heard(u: Utterance) {
    const chat = useChat.getState();
    const mic = owner();
    if (mic?.mode === "hold") holdDone();
    const agent = mic ? (chat.roster.find((a) => agentKey(a) === mic.agent) ?? null) : resolveAgent(u.agent, chat.roster, this.current, chat.activeAgent);
    const written = !!mic && !u.callId && replyOf(mic.agent) === "written";
    const reply = u.callId ? toModel(u.callId) : written ? inWriting : aloud(agent ? agentKey(agent) : null, agent ? voiceOf(agent) : undefined, !!mic);
    useVoiceStore.setState({ transcript: u.text, heardBy: agent?.name ?? null, error: null });
    if (!agent) {
      reply.answer(missingAgent(u.agent, wakeNames(chat.roster)));
      return;
    }
    const key = agentKey(agent);
    hushed.delete(key);
    if (!mic) {
      this.current = agent;
      chat.openDm(key);
    }
    const voice: DeskVoice = written
      ? { reply: "written" }
      : { reply: "spoken", speech: u.callId ? { provider: voiceEngine(useSettings.getState().voiceEngine).id } : speechOf(voiceOf(agent)) };
    const done = this.awaitAnswer(key, agent.name, reply, Boolean(u.callId));
    const attempt = (n: number) => {
      if (useChat.getState().send(key, u.text, { voice })) return;
      if (n < SEND_TRIES) setTimeout(() => attempt(n + 1), SEND_RETRY_MS);
      else {
        done();
        if (written) useVoiceStore.setState({ error: `Couldn’t reach ${agent.name}.` });
        else reply.answer(`I couldn't reach ${agent.name}.`);
      }
    };
    attempt(0);
  }

  /** Waits for the agent to answer, until its turn ends: each part of the
   *  answer is read out as it finishes, or for a voice model, which can take
   *  one result, all of it at the end. */
  private awaitAnswer(key: string, name: string, reply: Reply, cloud: boolean): () => void {
    this.waiting.get(key)?.();
    const since = Date.now();
    const baseline = asked(useChat.getState().conversations[key]);
    const whole: string[] = [];
    const giveUp = setTimeout(() => done(), ANSWER_WAIT_MS);
    const unsubscribe = useChat.subscribe((s, prev) => {
      const before = prev.conversations[key];
      const after = s.conversations[key];
      if (!before || !after || before === after) return;
      const answers = newAnswers(before, after, since);
      for (const answer of answers) {
        if (cloud) whole.push(forModel(answer.content));
        else if (!hushed.has(key)) reply.answer(speakable(answer.speech ?? answer.content));
      }
      const failure = failureIn(before, after);
      if (failure !== null) {
        done();
        if (cloud && whole.length) reply.answer(whole.join(" "));
        else if (!hushed.has(key)) reply.answer(`${name} couldn't answer. ${ERROR_IN_CHAT}`);
        return;
      }
      const over = saysWhenTurnsEnd(after) ? turnsOver(before, after, baseline) : answers.length > 0;
      if (!over) return;
      done();
      if (cloud) reply.answer(whole.length ? whole.join(" ") : `${name} had nothing to say.`);
    });
    const done = () => {
      clearTimeout(giveUp);
      unsubscribe();
      if (this.waiting.get(key) === done) this.waiting.delete(key);
      useVoiceStore.setState((s) => {
        const { [key]: _gone, ...waiting } = s.waiting;
        return { thinking: this.waiting.size > 0, waiting };
      });
    };
    this.waiting.set(key, done);
    useVoiceStore.setState((s) => ({ thinking: true, waiting: { ...s.waiting, [key]: true } }));
    return done;
  }

  stop() {
    for (const done of [...this.waiting.values()]) done();
    this.current = null;
  }
}

/** Gives the engine to whoever has the microphone (see `mic.ts`) whenever
 *  that changes; one that can't be had goes back to voice by name, saying
 *  why in the DM that asked. */
const followMic = (): (() => void) => {
  let mode = claimMode();
  const claim = (next: typeof mode) => {
    const claimed: Promise<unknown> = claimVoice(next)
      .catch((e: unknown) => {
        const who = owner();
        if (who) micFailed(who.agent, e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (claiming === claimed) claiming = null;
      });
    claiming = claimed;
    return claimed;
  };
  if (mode) void claim(mode);
  return useMic.subscribe((s) => {
    const next = claimMode(s);
    if (next === mode) return;
    mode = next;
    void claim(next);
  });
};

/** Voice, while `enabled`: wake on roster names, push-to-talk on the
 *  `pushToTalk` shortcut, requests to the named agent, answers read
 *  aloud or handed back to the cloud voice model, on the engine Desk's
 *  settings name. Whatever `enabled` is, a DM can take the microphone
 *  (`talkHere`, `holdToTalkHere`, or its own buttons), pausing voice by
 *  name until it gives it back.
 *  Mount once in the main window, e.g. `useVoice(useSettings((s) => s.voice))`. */
export function useVoice(enabled: boolean) {
  const engine = voiceEngine(useSettings((s) => s.voiceEngine)).id;
  const roster = useChat((s) => s.roster);
  const agentVoices = useSettings((s) => s.agentVoices);
  const members = voiceRoster(roster, agentVoices);
  const membersKey = JSON.stringify(members);

  useEffect(() => {
    if (enabled) {
      useVoiceStore.setState({ error: null });
      enableVoice(engine).catch(failed);
    } else void disableVoice().catch(failed);
  }, [enabled, engine]);

  useEffect(() => {
    setVoiceRoster(members).catch(failed);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the roster is tracked through `membersKey`
  }, [membersKey]);

  useEffect(() => {
    const turns = new Turns();
    const stops: Promise<() => void>[] = [
      onVoiceState((status) => {
        turns.status(status);
        useVoiceStore.setState({ status });
      }),
      onUtterance((u) => turns.heard(u)),
      onUnheard(holdDone),
      onSpeechStopped(() => turns.stopped()),
      onVoiceError((message) => useVoiceStore.setState({ error: message })),
    ];
    const unfollow = followMic();
    useVoiceStore.setState({ here: true });
    voiceStatus()
      .then((status) => useVoiceStore.setState({ status }))
      .catch(failed);
    return () => {
      turns.stop();
      unfollow();
      useVoiceStore.setState({ here: false });
      for (const stop of stops) void stop.then((f) => f());
    };
  }, []);

  const holdKeys = useSettings((s) => (s.loaded ? s.keys.pushToTalk : null));
  useGlobalShortcut("pushToTalk", enabled ? holdKeys : null, (e) => void pushToTalk(e.state === "Pressed").catch(failed));
  useAppShortcut(
    "talkHere",
    () => {
      const dm = targetDm();
      if (dm) talkOrEnd(dm);
    },
    true,
    { fromFields: false },
  );
  useAppHold(
    "holdToTalkHere",
    () => {
      const dm = targetDm();
      if (dm) startHold(dm);
    },
    endHold,
  );
}
