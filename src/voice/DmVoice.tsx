import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { deviceEntries, refreshDevices, useAudioDevices } from "../settings/Audio";
import { setAudio, useSettings } from "../settings/store";
import { shortcutLabel } from "../shortcuts/keys";
import { Menu, type MenuEntry } from "../ui/Menu";
import { stopSpeaking } from "./api";
import { toggleMute, useMic } from "./mic";
import { useVoiceStore } from "./store";
import { endConversation, endHold, setReply, startHold, talkOrEnd } from "./useVoice";
import { dmVoiceView } from "./view";
import "../styles/voice.css";

export function MicIcon() {
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

/** The microphone, speaker and echo cancelling, as a menu's entries: to
 *  change them mid-conversation without going to Settings. */
export const useAudioEntries = (): MenuEntry[] => {
  const audio = useSettings((s) => s.audio);
  // Subscribed, so a read made as a submenu opens shows in it at once.
  const devices = useAudioDevices("off");
  // Read as a submenu opens (outside the render; shared and spaced out
  // however many rows ask), so a headset plugged in since shows.
  const list = (which: "inputs" | "outputs") => {
    queueMicrotask(refreshDevices);
    return devices[which];
  };
  return [
    { kind: "separator" },
    { kind: "item", label: "Microphone", hint: audio.input?.name ?? "Same as system", submenu: () => deviceEntries(list("inputs"), audio.input, (input) => setAudio({ input })) },
    { kind: "item", label: "Speaker", hint: audio.output?.name ?? "Same as system", submenu: () => deviceEntries(list("outputs"), audio.output, (output) => setAudio({ output })) },
    { kind: "item", label: "Echo cancelling", detail: "Off suits headphones", checked: audio.echoCancel, onSelect: () => setAudio({ echoCancel: !audio.echoCancel }) },
  ];
};

/** Whether `agent` (`name`) answers what's said aloud or in writing, as a
 *  menu's entries. */
export const answerEntries = (agent: string, name: string, written: boolean): MenuEntry[] => [
  { kind: "item", label: `${name} answers aloud`, radio: true, checked: !written, onSelect: () => setReply(agent, "spoken") },
  { kind: "item", label: `${name} answers in writing`, radio: true, checked: written, onSelect: () => setReply(agent, "written") },
];

/** Whether voice runs in this window: Desk's main window runs it, a grid in
 *  a window of its own shows none of it. */
export const useVoiceHere = (): boolean => useVoiceStore((s) => s.here);

/** A hold-to-talk button's handlers for `agent`: held while the pointer or
 *  Space or Enter is down on it, let go however it ends, and let go if the
 *  button goes while it's held. */
export const useHoldButton = (agent: string) => {
  const holding = useRef(false);
  useEffect(
    () => () => {
      if (holding.current) endHold();
    },
    [],
  );
  const start = () => {
    holding.current = true;
    startHold(agent);
  };
  const end = () => {
    holding.current = false;
    endHold();
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      start();
      // Let go anywhere, it's still let go here.
      if ("setPointerCapture" in e.currentTarget) e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) {
        e.preventDefault();
        start();
      }
    },
    onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === " " || e.key === "Enter") end();
    },
    onBlur: end,
  };
};

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
  const audioEntries = useAudioEntries();
  const hold = useHoldButton(agent);
  // Read when the menu opens, so its submenus have the devices.
  useEffect(() => {
    if (menu) refreshDevices();
  }, [menu]);
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
        {...hold}
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
          label={`How ${name} answers, and the microphone and speaker`}
          at={menu}
          entries={[...answerEntries(agent, name, written), ...audioEntries]}
          onClose={(refocus) => {
            setMenu(null);
            if (refocus) more.current?.focus();
          }}
        />
      )}
    </span>
  );
}

/** A DM's voice controls as a menu's entries, for a composer too narrow for
 *  the buttons: talking on or off, and how the agent answers. Holding to
 *  talk needs a button held down, so the menu names its keys instead. None
 *  where voice doesn't run. */
export function useDmVoiceEntries(agent: string, name: string): MenuEntry[] {
  const talking = useMic((m) => m.talk === agent);
  const written = useSettings((s) => s.writtenReplies.includes(agent));
  const holdKeys = useSettings((s) => s.keys.holdToTalkHere);
  const talkKeys = useSettings((s) => s.keys.talkHere);
  const here = useVoiceHere();
  const audioEntries = useAudioEntries();
  if (!here) return [];
  return [
    { kind: "separator" },
    {
      kind: "item",
      label: talking ? `End the conversation with ${name}` : `Talk with ${name}`,
      kbd: shortcutLabel(talkKeys),
      onSelect: () => talkOrEnd(agent),
    },
    { kind: "item", label: "Hold to talk", hint: "hold the keys", kbd: shortcutLabel(holdKeys), disabled: true },
    { kind: "separator" },
    ...answerEntries(agent, name, written),
    ...audioEntries,
  ];
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
        <>
          <button type="button" className="link small" onClick={toggleMute}>
            {mic.muted ? "Unmute" : "Mute"}
          </button>
          <button type="button" className="link small" onClick={() => endConversation(agent)}>
            End
          </button>
        </>
      )}
    </div>
  );
}

/** In a grid pane's header, or on the agent's sidebar row: this DM has the
 *  microphone. */
export function MicBadge({ agent, className = "gpane-mic" }: { agent: string; className?: string }) {
  const live = useMic((m) => m.hold === agent || (m.talk === agent && !m.hold));
  if (!live) return null;
  return (
    <span className={className} role="img" aria-label="Has the microphone" title="Has the microphone">
      <MicIcon />
    </span>
  );
}
