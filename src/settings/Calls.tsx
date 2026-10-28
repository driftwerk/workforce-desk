import { useEffect, useState } from "react";
import { onTupleStatus, subscribe, type TupleStatus } from "../platform";
import { shortcutLabel } from "../shortcuts/keys";
import { VOICE_ENGINES, voiceEngine } from "../voice/engines";
import { ShortcutField } from "./ShortcutField";
import { useSettings } from "./store";

export function Calls() {
  const { tuple, voice, voiceEngine: engineId, pushToTalkShortcut, set } = useSettings();
  const engine = voiceEngine(engineId);
  const [status, setStatus] = useState<TupleStatus>({ state: "off" });
  useEffect(() => subscribe(onTupleStatus(setStatus)), []);
  return (
    <section className="settings-pane" aria-label="Calls">
      <h1 className="display-lg">Calls and voice</h1>
      <label className="toggle-row">
        <input type="checkbox" checked={voice} onChange={(e) => set({ voice: e.target.checked })} />
        <span>
          <b>Talk to agents by name</b>
          <span className="muted small">
            Say an agent’s name — “Atlas, what failed overnight?” — or hold {shortcutLabel(pushToTalkShortcut)} to talk. {engine.privacy}
          </span>
        </span>
      </label>
      {voice && (
        <div className="set-group">
          <span className="set-label">Voice</span>
          <div className="seg" role="radiogroup" aria-label="Voice engine">
            {VOICE_ENGINES.map((e) => (
              <button key={e.id} type="button" role="radio" aria-checked={engine.id === e.id} onClick={() => set({ voiceEngine: e.id })}>
                {e.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="set-group">
        <span className="set-label">Shortcuts</span>
        <ShortcutField id="pushToTalk" about="Hold to talk to an agent, let go to send. Works while voice is on." />
        <ShortcutField id="ask" about="Opens Ask anyone from any app." />
      </div>
      <label className="toggle-row">
        <input type="checkbox" checked={tuple} onChange={(e) => set({ tuple: e.target.checked })} />
        <span>
          <b>Ask agents from Tuple calls</b>
          <span className="muted small">
            Say an agent’s name on a call (“Atlas, what failed overnight?”) or type to it in Tuple’s chat. Only your own
            requests count; what others say is passed on as context. Answers appear over the call.
          </span>
        </span>
      </label>
      {tuple && (
        <p className="small">
          {status.state === "following" && <span className="state-done">Following your calls</span>}
          {status.state === "unavailable" && <span className="state-blocked">Tuple isn’t reachable: {status.reason}</span>}
          {status.state === "off" && <span className="faint">Starting…</span>}
        </p>
      )}
    </section>
  );
}
