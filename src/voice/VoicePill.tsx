import type { CSSProperties } from "react";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { useShortcuts } from "../shortcuts/manager";
import { Mark } from "../ui/Mark";
import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { stopSpeaking } from "./api";
import { owner, useMic } from "./mic";
import { useVoiceStore } from "./store";
import { retryVoice } from "./useVoice";
import { ProblemNote } from "../ui/ProblemNote";
import { permissionProblem, useRecheckOnFocus } from "../ui/privacy";
import { pillView, STEPS } from "./view";
import { MicIcon } from "./DmVoice";
import "../styles/voice.css";

/** Voice by name at a glance: what it's doing, what it heard, and the mic
 *  switch (Desk's `voice` setting; mount `useVoice` with that setting). A
 *  spoken conversation shows in the title bar's pill (`TalkPill`) instead. */
export function VoicePill() {
  const { status, thinking, heardBy, transcript, error } = useVoiceStore();
  const on = useSettings((s) => s.voice);
  const setSettings = useSettings((s) => s.set);
  // The system keeping the microphone from Desk: said with the setting that
  // allows it, and voice starts again once Desk is back in front with it.
  const micProblem = error ? permissionProblem(error, "starting voice") : null;
  useRecheckOnFocus("microphone", micProblem !== null, retryVoice);
  const holdKeys = useSettings((s) => s.keys.pushToTalk);
  const holdTaken = useShortcuts((s) => s.status.pushToTalk.state === "taken");
  // A DM with the microphone, by its agent's name; a spoken conversation by
  // the agent it's with, whoever holds the microphone for now.
  const mics = useMic();
  const holder = mics.talk ? { agent: mics.talk, mode: "talk" as const } : owner(mics);
  const holderName = useChat((s) => (holder ? (s.roster.find((a) => agentKey(a) === holder.agent)?.name ?? null) : null));
  const mic = holder && holderName ? { name: holderName, byName: on, talk: holder.mode === "talk" } : null;
  const view = pillView(status, thinking, heardBy, transcript, { label: shortcutLabel(holdKeys), available: !holdTaken }, mic);
  const current = view.step ? STEPS.findIndex((s) => s.step === view.step) : -1;
  const ring = { "--voice-progress": view.progress ?? 0 } as CSSProperties;

  return (
    <section
      className={`voice-pill voice-${status.state}${thinking ? " voice-thinking" : ""}${mic ? " voice-held" : ""}`}
      aria-label="Voice"
      aria-live="polite"
    >
      <div className="voice-row">
        <span className="voice-ring" style={ring}>
          {view.agent ? <Mark name={view.agent} size="sm" /> : <span className="voice-face"><MicIcon /></span>}
        </span>
        <span className="voice-text">
          <span className="voice-title">{view.title}</span>
          <span className={error && !micProblem ? "voice-detail voice-error" : "voice-detail"}>{micProblem ? view.detail : (error ?? view.detail)}</span>
        </span>
        {status.state === "speaking" && !mic?.talk && (
          <button type="button" className="voice-btn" onClick={() => void stopSpeaking()} aria-label="Stop speaking">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={`voice-btn voice-mic${on ? " on" : ""}`}
          aria-pressed={on}
          aria-label={on ? "Turn voice off" : "Turn voice on"}
          onClick={() => setSettings({ voice: !on })}
        >
          <MicIcon />
        </button>
      </div>
      {micProblem && <ProblemNote problem={micProblem} className="voice-problem" />}
      {current >= 0 && (
        <ol className="voice-steps" aria-label="Turn progress">
          {STEPS.map((s, i) => (
            <li key={s.step} className={i === current ? "now" : i < current ? "done" : ""}>
              {s.label}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
