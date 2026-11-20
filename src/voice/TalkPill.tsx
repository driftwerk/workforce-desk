import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChat } from "../chat/store";
import { agentKey } from "../chat/types";
import { refreshDevices, useLevel } from "../settings/Audio";
import { useSettings } from "../settings/store";
import { openTarget } from "../shell/navigate";
import { useUi } from "../shell/ui";
import { shortcutLabel } from "../shortcuts/keys";
import { AgentMark } from "../ui/Mark";
import { Menu, MenuRows, type MenuEntry } from "../ui/Menu";
import { Popover } from "../ui/Popover";
import type { Problem } from "../ui/problem";
import { ProblemNote } from "../ui/ProblemNote";
import { permissionProblem, useRecheckOnFocus } from "../ui/privacy";
import { stopSpeaking } from "./api";
import { answerEntries, MicIcon, useAudioEntries, useHoldButton, useVoiceHere } from "./DmVoice";
import { useDmShown } from "./dms";
import { dismissProblem, toggleMute, toggleTalk, useMic } from "./mic";
import { useVoiceStore } from "./store";
import { endConversation, switchConversation } from "./useVoice";
import { clock, lastExchange, talkView, type TalkView } from "./view";
import "../styles/voice.css";

function MutedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" />
    </svg>
  );
}

const useAgentName = (key: string | null): string | null =>
  useChat((s) => (key ? (s.roster.find((a) => agentKey(a) === key)?.name ?? null) : null));

const openDm = (agent: string): void => {
  useUi.getState().closeSettings();
  openTarget({ kind: "agent", key: agent });
};

/** How long it has been since `since`, as a clock ticking each second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{clock(now - since)}</>;
}

/** How loud the microphone is, as a few bars. */
function Meter() {
  const bars = useRef<HTMLSpanElement>(null);
  useLevel(true, (f) => bars.current?.style.setProperty("--level", String(f)));
  return (
    <span ref={bars} className="talk-meter" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

/** What can be changed mid-conversation with `agent` (`name`): how it
 *  answers, the microphone and speaker, and who the conversation is with. */
const useTalkEntries = (agent: string, name: string): MenuEntry[] => {
  const written = useSettings((s) => s.writtenReplies.includes(agent));
  const audio = useAudioEntries();
  const { roster, hubs } = useChat(useShallow((s) => ({ roster: s.roster, hubs: s.hubs })));
  const others = roster.filter((a) => agentKey(a) !== agent);
  const switchTo: MenuEntry[] = others.length
    ? [
        { kind: "separator" },
        {
          kind: "item",
          label: "Switch to",
          submenu: () =>
            others.map((a) => ({
              kind: "item" as const,
              label: a.name,
              hint: roster.filter((b) => b.name === a.name).length > 1 ? hubs.find((h) => h.id === a.hubId)?.label : undefined,
              onSelect: () => switchConversation(agentKey(a)),
            })),
        },
      ]
    : [];
  return [...answerEntries(agent, name, written), ...audio, ...switchTo];
};

/** The popover's body: who the conversation is with and since when, what
 *  was said last, its controls and choices; or what kept the microphone
 *  from it, with the fix. */
function TalkDetails({ agent, name, view, problem }: { agent: string; name: string; view: TalkView; problem: Problem | null }) {
  const { since, from, muted, holding } = useMic(
    useShallow((m) => ({ since: m.since, from: m.from, muted: m.muted, holding: m.hold === agent && m.pressed })),
  );
  const fromName = useAgentName(from);
  const said = useChat(useShallow((s) => lastExchange(since === null ? [] : (s.conversations[agent]?.messages ?? []), since ?? 0)));
  const hold = useHoldButton(agent);
  const entries = useTalkEntries(agent, name);
  const muteKeys = useSettings((s) => s.keys.muteTalk);
  useEffect(refreshDevices, []);
  return (
    <>
      <div className="talk-pop-head">
        <span className={`talk-pop-mark talk-${view.tone}`}>
          <AgentMark agent={agent} name={name} size="md" />
        </span>
        <span className="talk-pop-title">
          <span className="strong">{problem ? `Couldn’t talk with ${name}` : `Talking with ${name}`}</span>
          {since !== null && (
            <span className="small muted">
              {fromName ? `Moved from ${fromName}` : "Started in the DM"} · <Elapsed since={since} />
            </span>
          )}
        </span>
        <button type="button" className="link small talk-pop-dm" onClick={() => openDm(agent)}>
          Open DM
        </button>
      </div>
      {problem ? (
        <>
          <ProblemNote problem={problem} />
          <div className="talk-pop-actions">
            <button type="button" className="btn btn-signal" onClick={() => toggleTalk(agent)}>
              Try again
            </button>
            <button type="button" className="btn" onClick={dismissProblem}>
              Dismiss
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="talk-pop-said" role="group" aria-label="What was said last">
            {said.you || said.agent ? (
              <>
                {said.you && (
                  <p>
                    <span className="faint">You · </span>
                    {said.you}
                  </p>
                )}
                {said.agent && (
                  <p>
                    <span className="talk-pop-agent">{name} · </span>
                    {said.agent}
                  </p>
                )}
              </>
            ) : (
              <p className="faint">Nothing said yet: talk, and {name} hears it.</p>
            )}
          </div>
          <div className="talk-pop-actions">
            <button type="button" className="btn" aria-pressed={muted} title={`${muted ? "Unmute" : "Mute"} (${shortcutLabel(muteKeys)})`} onClick={toggleMute}>
              {muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" className="btn" aria-pressed={holding} {...hold}>
              Hold to talk
            </button>
            <button type="button" className="btn btn-signal" onClick={() => endConversation(agent)}>
              End
            </button>
          </div>
          <MenuRows label={`How ${name} answers, the microphone and speaker`} entries={entries} />
        </>
      )}
    </>
  );
}

/** The spoken conversation, in the title bar on every view until it's
 *  ended: who it's with, what it's doing, Mute, its choices and End, and a
 *  popover with the rest. In the agent's own DM, whose voice bar says it
 *  all, only a dot. A microphone that couldn't be had shows here too, with
 *  its fix. */
export function TalkPill() {
  const mic = useMic();
  const agent = mic.problem?.agent ?? mic.talk;
  const status = useVoiceStore((s) => s.status);
  const speakingFor = useVoiceStore((s) => s.speakingFor);
  const waiting = useVoiceStore((s) => !!agent && !!s.waiting[agent]);
  const here = useVoiceHere();
  const name = useAgentName(agent);
  const inDm = useDmShown(agent);
  const muteKeys = useSettings((s) => s.keys.muteTalk);
  const permission = mic.problem ? permissionProblem(mic.problem.message, "starting the microphone") : null;
  const problem: Problem | null = mic.problem ? (permission ?? { plain: mic.problem.message, what: "starting the microphone" }) : null;
  useRecheckOnFocus("microphone", permission !== null, () => {
    const failed = useMic.getState().problem;
    if (failed) toggleTalk(failed.agent);
  });
  const [from, setFrom] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  const entries = useTalkEntries(agent ?? "", name ?? "");
  useEffect(() => {
    setFrom(null);
    setMenu(null);
  }, [agent, inDm]);
  useEffect(() => {
    if (menu) refreshDevices();
  }, [menu]);
  const view = talkView(mic, status, waiting, speakingFor, permission !== null);
  if (!here || !view || !agent || !name) return null;
  const toggle = (el: HTMLElement) => setFrom((open) => (open ? null : el));
  const popover = from && (
    <Popover label={`Talking with ${name}`} from={from} align="center" className="talk-pop" onClose={() => setFrom(null)}>
      <TalkDetails agent={agent} name={name} view={view} problem={problem} />
    </Popover>
  );
  if (inDm)
    return (
      <div className={`talk-pill talk-dot talk-${view.tone}`} onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="talk-dot-btn"
          aria-haspopup="dialog"
          aria-expanded={!!from}
          aria-label={`Talking with ${name}: conversation controls`}
          title={`${name} · ${view.line}`}
          onClick={(e) => toggle(e.currentTarget)}
        >
          <span className="talk-dot-mark" aria-hidden="true" />
        </button>
        {popover}
      </div>
    );
  const muteLabel = mic.muted ? "Unmute your microphone" : "Mute your microphone";
  return (
    <div className={`talk-pill talk-${view.tone}`} role="group" aria-label={`Talking with ${name}`} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className="talk-who" aria-label={`Open ${name}’s DM`} title={`Open ${name}’s DM`} onClick={() => openDm(agent)}>
        {problem ? (
          <span className="talk-alert" aria-hidden="true">
            !
          </span>
        ) : (
          <AgentMark agent={agent} name={name} size="xs" />
        )}
        <span className="talk-name">{name}</span>
      </button>
      <button
        type="button"
        className="talk-state"
        aria-haspopup={mic.muted && !problem ? undefined : "dialog"}
        aria-expanded={mic.muted && !problem ? undefined : !!from}
        title={mic.muted && !problem ? "Unmute" : "Conversation controls"}
        onClick={(e) => (mic.muted && !problem ? toggleMute() : toggle(e.currentTarget))}
      >
        {view.tone === "live" && !view.speaking && <Meter />}
        <span className="talk-line">
          {view.line}
          {view.elapsed && mic.since !== null && (
            <>
              {" · "}
              <Elapsed since={mic.since} />
            </>
          )}
        </span>
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {`${name}: ${view.line}`}
      </span>
      {view.speaking && (
        <button type="button" className="btn btn-sm talk-stop" onClick={() => void stopSpeaking()}>
          Stop reply
        </button>
      )}
      {!problem && (
        <>
          <button
            type="button"
            className="icon-btn-sm talk-icon"
            aria-pressed={mic.muted}
            aria-label={muteLabel}
            title={`${muteLabel} (${shortcutLabel(muteKeys)})`}
            onClick={toggleMute}
          >
            {mic.muted ? <MutedIcon /> : <MicIcon />}
          </button>
          <button
            ref={more}
            type="button"
            className="icon-btn-sm talk-icon"
            aria-label={`How ${name} answers, the microphone and speaker`}
            aria-haspopup="menu"
            title={`How ${name} answers, the microphone and speaker`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4 });
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
              <path d="M1 3.5 5 7.5 9 3.5Z" />
            </svg>
          </button>
        </>
      )}
      {problem ? (
        <button type="button" className="btn btn-sm talk-end" onClick={dismissProblem}>
          Dismiss
        </button>
      ) : (
        <button type="button" className="btn btn-sm btn-signal talk-end" onClick={() => endConversation(agent)}>
          End
        </button>
      )}
      {menu && (
        <Menu
          label={`How ${name} answers, the microphone and speaker`}
          at={menu}
          entries={entries}
          onClose={(refocus) => {
            setMenu(null);
            if (refocus) more.current?.focus();
          }}
        />
      )}
      {popover}
    </div>
  );
}
