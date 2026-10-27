import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { useEffect } from "react";
import { useChat } from "../chat/store";
import { agentKey, type Agent } from "../chat/types";
import { useSettings } from "../settings/store";
import {
  disableVoice,
  enableVoice,
  onUtterance,
  onVoiceError,
  onVoiceState,
  pushToTalk,
  setVoiceNames,
  speak,
  toolResult,
  voiceStatus,
  type Utterance,
  type VoiceStatus,
} from "./api";
import { voiceEngine } from "./engines";
import { acknowledgement, forModel, missingAgent, outcome, resolveAgent, wakeNames } from "./route";
import { DETAILS_IN_DESK, speakable } from "./speakable";
import { useVoiceStore } from "./store";

/** Hold to talk, release to send. */
export const PUSH_TO_TALK = "Alt+Super+Space";

const ACK_AFTER_MS = 2_000;
const ANSWER_WAIT_MS = 10 * 60_000;
const SEND_TRIES = 60;
const SEND_RETRY_MS = 150;

const failed = (e: unknown) => useVoiceStore.setState({ error: e instanceof Error ? e.message : String(e) });

/** Where an answer goes: read aloud (the cascade), or back to the cloud
 *  voice model that asked, which says it in its own words. */
interface Reply {
  answer: (text: string) => void;
  /** Said while a slow answer is on its way; the cloud models do their own. */
  ack?: (text: string) => void;
}

const aloud: Reply = {
  answer: (text) => void speak(text).catch(failed),
  ack: (text) => void speak(text, true).catch(failed),
};

const toModel = (callId: string): Reply => ({
  answer: (text) => void toolResult(callId, text).catch(failed),
});

/** Spoken turns: each utterance goes to its agent's DM through the chat
 *  store, and the answer goes back when it finishes. */
export class Turns {
  private current: Agent | null = null;
  private turn = 0;
  private waiting = new Map<string, () => void>();

  status(s: VoiceStatus) {
    if (s.state === "off" || (s.state === "listening" && s.conversation === null)) this.current = null;
  }

  heard(u: Utterance) {
    const chat = useChat.getState();
    const agent = resolveAgent(u.agent, chat.roster, this.current, chat.activeAgent);
    const reply = u.callId ? toModel(u.callId) : aloud;
    useVoiceStore.setState({ transcript: u.text, heardBy: agent?.name ?? null, error: null });
    if (!agent) {
      reply.answer(missingAgent(u.agent, wakeNames(chat.roster)));
      return;
    }
    this.current = agent;
    const key = agentKey(agent);
    chat.openDm(key);
    const done = this.awaitAnswer(key, agent.name, reply, Boolean(u.callId));
    const attempt = (n: number) => {
      if (useChat.getState().send(key, u.text)) return;
      if (n < SEND_TRIES) setTimeout(() => attempt(n + 1), SEND_RETRY_MS);
      else {
        done();
        reply.answer(`I couldn't reach ${agent.name}.`);
      }
    };
    attempt(0);
  }

  private awaitAnswer(key: string, name: string, reply: Reply, cloud: boolean): () => void {
    this.waiting.get(key)?.();
    const ack = reply.ack && setTimeout(() => reply.ack?.(acknowledgement(name, this.turn++)), ACK_AFTER_MS);
    const giveUp = setTimeout(() => done(), ANSWER_WAIT_MS);
    const unsubscribe = useChat.subscribe((s, prev) => {
      const before = prev.conversations[key];
      const after = s.conversations[key];
      if (!before || !after || before === after) return;
      const o = outcome(before, after);
      if (!o) return;
      done();
      if (o.kind === "error") reply.answer(`${name} couldn't answer. ${DETAILS_IN_DESK}`);
      else reply.answer(cloud ? forModel(o.text) : speakable(o.text));
    });
    const done = () => {
      clearTimeout(ack);
      clearTimeout(giveUp);
      unsubscribe();
      if (this.waiting.get(key) === done) this.waiting.delete(key);
      useVoiceStore.setState({ thinking: this.waiting.size > 0 });
    };
    this.waiting.set(key, done);
    useVoiceStore.setState({ thinking: true });
    return done;
  }

  stop() {
    for (const done of [...this.waiting.values()]) done();
    this.current = null;
  }
}

/** Voice, while `enabled`: wake on roster names, push-to-talk on
 *  {@link PUSH_TO_TALK}, requests to the named agent, answers read aloud or
 *  handed back to the cloud voice model, on the engine Desk's settings name.
 *  Mount once in the shell, e.g. `useVoice(useSettings((s) => s.voice))`. */
export function useVoice(enabled: boolean) {
  const engine = voiceEngine(useSettings((s) => s.voiceEngine)).id;
  const roster = useChat((s) => s.roster);
  const names = wakeNames(roster);
  const namesKey = names.join("\u0000");

  useEffect(() => {
    if (enabled) {
      useVoiceStore.setState({ error: null });
      enableVoice(engine).catch(failed);
    } else void disableVoice().catch(failed);
  }, [enabled, engine]);

  useEffect(() => {
    setVoiceNames(names).catch(failed);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- names are tracked through `namesKey`
  }, [namesKey]);

  useEffect(() => {
    const turns = new Turns();
    const stops: Promise<() => void>[] = [
      onVoiceState((status) => {
        turns.status(status);
        useVoiceStore.setState({ status });
      }),
      onUtterance((u) => turns.heard(u)),
      onVoiceError((message) => useVoiceStore.setState({ error: message })),
    ];
    voiceStatus()
      .then((status) => useVoiceStore.setState({ status }))
      .catch(failed);
    return () => {
      turns.stop();
      for (const stop of stops) void stop.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    register(PUSH_TO_TALK, (e) => void pushToTalk(e.state === "Pressed").catch(failed)).catch(failed);
    return () => void unregister(PUSH_TO_TALK).catch(failed);
  }, [enabled]);
}
