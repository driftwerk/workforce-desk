import { create } from "zustand";

/** Who has the microphone. One owner at a time:
 *
 *    owner = hold ?? talk ?? voice by name
 *
 *  - `talk`: a DM's spoken conversation, on until it's turned off;
 *    everything said is for that agent.
 *  - `hold`: hold to talk in a DM, from the press until what was said has
 *    been sent (or nothing was heard). It borrows the microphone from
 *    whoever had it, a talking DM included, and gives it back.
 *  - neither: "Voice: talk to any agent by name", if it's on. It is paused
 *    while a DM has the microphone and resumes after.
 *
 *  Agents are named by agent key (`hub/agent`). */
export interface MicState {
  talk: string | null;
  hold: string | null;
  /** The hold's key or button is still down. */
  pressed: boolean;
  /** Answers to a DM being read out: the engine that says them stays up, whoever
   *  has the microphone by then, hearing nothing but someone talking over it. */
  replying: number;
  /** Why the microphone couldn't be had, for the DM that asked. */
  problem: { agent: string; message: string } | null;
  /** The talk hears only what's held, without ending. */
  muted: boolean;
  /** When the talk started (ms). */
  since: number | null;
  /** The agent the talk was moved from, or null when it started in its own DM. */
  from: string | null;
}

export const QUIET: MicState = { talk: null, hold: null, pressed: false, replying: 0, problem: null, muted: false, since: null, from: null };

export const useMic = create<MicState>(() => QUIET);

const noTalk = { talk: null, muted: false, since: null, from: null } as const;

const talkWith = (agent: string, from: string | null) => ({ talk: agent, muted: false, since: Date.now(), from, problem: null });

export type Owner = { agent: string; mode: "talk" | "hold" };

/** Who the microphone is listening for, or null for voice by name. */
export const owner = (s: Pick<MicState, "talk" | "hold"> = useMic.getState()): Owner | null =>
  s.hold ? { agent: s.hold, mode: "hold" } : s.talk ? { agent: s.talk, mode: "talk" } : null;

/** How the engine listens for the owner (`voice_claim`'s mode): every word
 *  for a talking DM that isn't muted; only what's held while a hold is in
 *  hand, unless it's the talking DM's own, or while muted; and while a DM's
 *  answer is read out once nobody has the microphone, only to tell when
 *  someone talks over it. */
export const claimMode = (s: Pick<MicState, "talk" | "hold" | "replying" | "muted"> = useMic.getState()): "open" | "held" | null =>
  s.hold ? (s.hold === s.talk && !s.muted ? "open" : "held") : s.talk ? (s.muted ? "held" : "open") : s.replying > 0 ? "held" : null;

/** A DM's answer is about to be read out. */
export const replyStarted = (): void => useMic.setState((s) => ({ replying: s.replying + 1 }));

/** What was being read out is over. */
export const repliesOver = (): void => useMic.setState({ replying: 0 });

/** Turns `agent`'s spoken conversation on, taking the microphone from any
 *  other DM's, or off. */
export const toggleTalk = (agent: string): void =>
  useMic.setState((s) => (s.talk === agent ? { ...noTalk, problem: null } : talkWith(agent, null)));

/** Moves the spoken conversation to `agent` in one step: the microphone
 *  never goes back to voice by name between the two. */
export const switchTalk = (agent: string): void => useMic.setState((s) => (s.talk && s.talk !== agent ? talkWith(agent, s.talk) : {}));

export const endTalk = (agent: string): void => useMic.setState((s) => (s.talk === agent ? noTalk : {}));

/** Mutes the spoken conversation, or unmutes it. */
export const toggleMute = (): void => useMic.setState((s) => (s.talk ? { muted: !s.muted } : {}));

export const dismissProblem = (): void => useMic.setState({ problem: null });

/** Hold to talk in `agent`'s DM: pressed. */
export const pressHold = (agent: string): void => useMic.setState({ hold: agent, pressed: true, problem: null });

/** Let go: what was held is being transcribed. */
export const releaseHold = (): void => useMic.setState({ pressed: false });

/** What was held was sent, or nothing was heard: the microphone goes back. */
export const holdDone = (): void => useMic.setState((s) => (s.pressed ? {} : { hold: null }));

/** The microphone couldn't be had for `agent`: it goes back to voice by
 *  name, saying why in that DM. */
export const micFailed = (agent: string, message: string): void =>
  useMic.setState({ ...QUIET, problem: { agent, message } });

/** `agent` isn't on the roster any more: whatever it held is let go. */
export const forget = (agent: string): void =>
  useMic.setState((s) => ({
    ...(s.talk === agent ? noTalk : {}),
    hold: s.hold === agent ? null : s.hold,
    pressed: s.hold === agent ? false : s.pressed,
    problem: s.problem?.agent === agent ? null : s.problem,
  }));
