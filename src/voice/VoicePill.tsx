import type { CSSProperties } from "react";
import { useSettings } from "../settings/store";
import { Mark } from "../ui/Mark";
import { stopSpeaking } from "./api";
import { useVoiceStore } from "./store";
import { pillView, STEPS } from "./view";
import "../styles/voice.css";

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

/** Voice at a glance: what it's doing, what it heard, and the mic switch
 *  (Desk's `voice` setting; mount `useVoice` with that setting). */
export function VoicePill() {
  const { status, thinking, heardBy, transcript, error } = useVoiceStore();
  const on = useSettings((s) => s.voice);
  const setSettings = useSettings((s) => s.set);
  const view = pillView(status, thinking, heardBy, transcript);
  const current = view.step ? STEPS.findIndex((s) => s.step === view.step) : -1;
  const ring = { "--voice-progress": view.progress ?? 0 } as CSSProperties;

  return (
    <section className={`voice-pill voice-${status.state}${thinking ? " voice-thinking" : ""}`} aria-label="Voice" aria-live="polite">
      <div className="voice-row">
        <span className="voice-ring" style={ring}>
          {view.agent ? <Mark name={view.agent} size="sm" /> : <span className="voice-face"><MicIcon /></span>}
        </span>
        <span className="voice-text">
          <span className="voice-title">{view.title}</span>
          <span className={error ? "voice-detail voice-error" : "voice-detail"}>{error ?? view.detail}</span>
        </span>
        {status.state === "speaking" && (
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
