import { create } from "zustand";
import type { VoiceStatus } from "./api";

interface VoiceStore {
  status: VoiceStatus;
  /** What was last heard, and who it went to. */
  transcript: string;
  heardBy: string | null;
  /** A request is with an agent and its answer hasn't been spoken yet. */
  thinking: boolean;
  error: string | null;
}

export const useVoiceStore = create<VoiceStore>(() => ({
  status: { state: "off" },
  transcript: "",
  heardBy: null,
  thinking: false,
  error: null,
}));
