import { create } from "zustand";
import type { VoiceStatus } from "./api";

interface VoiceStore {
  status: VoiceStatus;
  /** What was last heard, and who it went to. */
  transcript: string;
  heardBy: string | null;
  /** A request is with an agent and its answer hasn't been spoken yet. */
  thinking: boolean;
  /** The agents, by key, with a request said to them still unanswered. */
  waiting: Record<string, true>;
  /** Whose answer is being read aloud. */
  speakingFor: string | null;
  /** Voice runs in this window (`useVoice` is mounted). */
  here: boolean;
  error: string | null;
}

export const useVoiceStore = create<VoiceStore>(() => ({
  status: { state: "off" },
  transcript: "",
  heardBy: null,
  thinking: false,
  waiting: {},
  speakingFor: null,
  here: false,
  error: null,
}));
