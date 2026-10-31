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
  /** Why the microphone couldn't be had, for the DM that asked. */
  problem: { agent: string; message: string } | null;
}

export const useMic = create<MicState>(() => ({ talk: null, hold: null, pressed: false, problem: null }));

export type Owner = { agent: string; mode: "talk" | "hold" };

/** Who the microphone is listening for, or null for voice by name. */
export const owner = (s: Pick<MicState, "talk" | "hold"> = useMic.getState()): Owner | null =>
  s.hold ? { agent: s.hold, mode: "hold" } : s.talk ? { agent: s.talk, mode: "talk" } : null;

/** How the engine listens for the owner (`voice_claim`'s mode): every word
 *  for a talking DM; only what's held while a hold is in hand, unless it's
 *  the talking DM's own hold. */
export const claimMode = (s: Pick<MicState, "talk" | "hold"> = useMic.getState()): "open" | "held" | null =>
  s.hold ? (s.hold === s.talk ? "open" : "held") : s.talk ? "open" : null;

/** Turns `agent`'s spoken conversation on, taking the microphone from any
 *  other DM's, or off. */
export const toggleTalk = (agent: string): void =>
  useMic.setState((s) => ({ talk: s.talk === agent ? null : agent, problem: null }));

export const endTalk = (agent: string): void => useMic.setState((s) => (s.talk === agent ? { talk: null } : {}));

/** Hold to talk in `agent`'s DM: pressed. */
export const pressHold = (agent: string): void => useMic.setState({ hold: agent, pressed: true, problem: null });

/** Let go: what was held is being transcribed. */
export const releaseHold = (): void => useMic.setState({ pressed: false });

/** What was held was sent, or nothing was heard: the microphone goes back. */
export const holdDone = (): void => useMic.setState((s) => (s.pressed ? {} : { hold: null }));

/** The microphone couldn't be had for `agent`: it goes back to voice by
 *  name, saying why in that DM. */
export const micFailed = (agent: string, message: string): void =>
  useMic.setState({ talk: null, hold: null, pressed: false, problem: { agent, message } });

/** `agent`'s DM isn't shown anywhere now: whatever it held is let go. */
export const forget = (agent: string): void =>
  useMic.setState((s) => ({
    talk: s.talk === agent ? null : s.talk,
    hold: s.hold === agent ? null : s.hold,
    pressed: s.hold === agent ? false : s.pressed,
    problem: s.problem?.agent === agent ? null : s.problem,
  }));
