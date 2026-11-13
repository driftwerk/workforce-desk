import { useEffect, useState } from "react";
import { onTupleStatus, subscribe, tupleAvailable, type TupleStatus } from "../platform";
import { shortcutLabel } from "../shortcuts/keys";
import { VOICE_ENGINES, voiceEngine } from "../voice/engines";
import { SwitchRow } from "../ui/SwitchRow";
import { useSettings } from "./store";

export function Calls() {
  const { tuple, voice, voiceEngine: engineId, keys, set } = useSettings();
  const engine = voiceEngine(engineId);
  const [status, setStatus] = useState<TupleStatus>({ state: "off" });
  const [hasTuple, setHasTuple] = useState(false);
  useEffect(() => subscribe(onTupleStatus(setStatus)), []);
  useEffect(() => {
    void tupleAvailable().then(setHasTuple, () => setHasTuple(false));
  }, []);
  return (
    <section className="settings-pane voices-detail" aria-label="Talking to agents">
      <h1 className="display-lg">Talking to agents</h1>
      <SwitchRow
        label="Talk to agents by name"
        sub={
          <>
            Say an agent’s name — “Atlas, what failed overnight?” — or hold {shortcutLabel(keys.pushToTalk)} to talk (change the keys in Shortcuts). {engine.privacy}
          </>
        }
        on={voice}
        onChange={(on) => set({ voice: on })}
      />
      {voice && (
        <section className="prov-section" aria-label="Voice">
          <h2 className="field-label">Voice</h2>
          <div className="seg" role="radiogroup" aria-label="Voice engine">
            {VOICE_ENGINES.map((e) => (
              <button key={e.id} type="button" role="radio" aria-checked={engine.id === e.id} onClick={() => set({ voiceEngine: e.id })}>
                {e.label}
              </button>
            ))}
          </div>
        </section>
      )}
      {hasTuple && (
        <SwitchRow
          label="Ask agents from Tuple calls"
          sub="Say an agent’s name on a call (“Atlas, what failed overnight?”) or type to it in Tuple’s chat. Only your own requests count; what others say is passed on as context. Answers appear over the call."
          on={tuple}
          onChange={(on) => set({ tuple: on })}
        />
      )}
      {hasTuple && tuple && (
        <p className="small">
          {status.state === "following" && <span className="state-done">Following your calls</span>}
          {status.state === "unavailable" && <span className="state-blocked">Tuple isn’t reachable: {status.reason}</span>}
          {status.state === "off" && <span className="faint">Starting…</span>}
        </p>
      )}
    </section>
  );
}
