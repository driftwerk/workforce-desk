import { useRef, useState } from "react";
import { useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { Menu } from "../ui/Menu";
import { stopSpeaking } from "./api";
import { useMic } from "./mic";
import { useVoiceStore } from "./store";
import { endConversation, endHold, setReply, startHold, talkOrEnd } from "./useVoice";
import { dmVoiceView } from "./view";
import "../styles/voice.css";

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function TalkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
    </svg>
  );
}

/** Whether voice runs in this window: Desk's main window runs it, a grid in
 *  a window of its own shows none of it. */
const useVoiceHere = (): boolean => useVoiceStore((s) => s.here);

/** A DM's voice controls, beside Send: hold to talk, a spoken conversation
 *  on or off, and whether the agent answers aloud or in writing. */
export function DmVoiceControls({ agent, name }: { agent: string; name: string }) {
  const talking = useMic((m) => m.talk === agent);
  const holding = useMic((m) => m.hold === agent && m.pressed);
  const written = useSettings((s) => s.writtenReplies.includes(agent));
  const holdKeys = useSettings((s) => s.keys.holdToTalkHere);
  const talkKeys = useSettings((s) => s.keys.talkHere);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  const here = useVoiceHere();
  if (!here) return null;
  const answers = written ? "answers in writing" : "answers aloud";
  return (
    <span className="dm-voice" role="group" aria-label={`Voice with ${name}`}>
      <button
        type="button"
        className={`icon-btn-sm composer-attach dm-voice-hold${holding ? " on" : ""}`}
        aria-label={`Hold to talk to ${name}`}
        aria-pressed={holding}
        title={`Hold to talk to ${name} (${shortcutLabel(holdKeys)}) · ${answers}`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          startHold(agent);
          // Let go anywhere, it's still let go here.
          if ("setPointerCapture" in e.currentTarget) e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerUp={endHold}
        onPointerCancel={endHold}
        onLostPointerCapture={endHold}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            startHold(agent);
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") endHold();
        }}
        onBlur={endHold}
      >
        <MicIcon />
      </button>
      <button
        type="button"
        className={`icon-btn-sm composer-attach dm-voice-talk${talking ? " on" : ""}`}
        aria-label={talking ? `End the conversation with ${name}` : `Talk with ${name}`}
        aria-pressed={talking}
        title={`${talking ? `End the conversation with ${name}` : `Talk with ${name} until you end it`} (${shortcutLabel(talkKeys)}) · ${answers}`}
        onClick={() => talkOrEnd(agent)}
      >
        <TalkIcon />
      </button>
      <button
        ref={more}
        type="button"
        className="icon-btn-sm composer-attach dm-voice-more"
        aria-label={`How ${name} answers when you talk`}
        aria-haspopup="menu"
        title={`How ${name} answers when you talk`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.top - 4 });
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
          <path d="M1 3.5 5 7.5 9 3.5Z" />
        </svg>
      </button>
      {menu && (
        <Menu
          label={`How ${name} answers when you talk`}
          at={menu}
          entries={[
            { kind: "item", label: `${name} answers aloud`, checked: !written, onSelect: () => setReply(agent, "spoken") },
            { kind: "item", label: `${name} answers in writing`, checked: written, onSelect: () => setReply(agent, "written") },
          ]}
          onClose={(refocus) => {
            setMenu(null);
            if (refocus) more.current?.focus();
          }}
        />
      )}
    </span>
  );
}

/** What voice is doing in a DM, above its composer: who's listening,
 *  thinking or speaking, and what went wrong. Nothing when it has nothing
 *  to say. */
export function DmVoiceBar({ agent, name }: { agent: string; name: string }) {
  const mic = useMic();
  const status = useVoiceStore((s) => s.status);
  const waiting = useVoiceStore((s) => !!s.waiting[agent]);
  const speakingFor = useVoiceStore((s) => s.speakingFor);
  const written = useSettings((s) => s.writtenReplies.includes(agent));
  const here = useVoiceHere();
  if (!here) return null;
  const view = dmVoiceView(agent, name, mic, status, waiting, speakingFor, written);
  if (!view) return null;
  return (
    <div className={`dm-voice-bar${view.live ? " live" : ""}${view.problem ? " problem" : ""}`} role="status" aria-live="polite">
      <span className="dm-voice-dot" aria-hidden="true" />
      <span className="dm-voice-line">{view.line}</span>
      {view.detail && <span className="dm-voice-detail">{view.detail}</span>}
      <span className="dm-voice-fill" />
      {view.speaking && (
        <button type="button" className="link small" onClick={() => void stopSpeaking()}>
          Stop
        </button>
      )}
      {mic.talk === agent && (
        <button type="button" className="link small" onClick={() => endConversation(agent)}>
          End
        </button>
      )}
    </div>
  );
}

/** In a grid pane's header: this DM has the microphone. */
export function MicBadge({ agent }: { agent: string }) {
  const live = useMic((m) => m.hold === agent || (m.talk === agent && !m.hold));
  if (!live) return null;
  return (
    <span className="gpane-mic" role="img" aria-label="Has the microphone" title="Has the microphone">
      <MicIcon />
    </span>
  );
}
