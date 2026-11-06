import { useState } from "react";
import { LOCAL, useMachines, type MachineId } from "../machines/engines";
import type { MachineNative } from "../machines/native";
import { offlineWord, thisComputer, usable } from "../machines/words";
import { useHost } from "../shell/host";
import { EngineBlocks } from "./EngineBlocks";

/** Settings → Engines: the engines on the computer Desk's sessions run
 *  on, and, once there are machines, on any of them ("On"): whether each is
 *  installed, its version, who it is signed in as, and its sign-in. */
export function Engines({ native, on }: { native?: MachineNative; on?: MachineId }) {
  const machines = useMachines((s) => s.machines);
  const platform = useHost((h) => h.platform);
  const [chosen, setChosen] = useState<MachineId>(on ?? LOCAL);
  // The machine chosen stays chosen through a reconnect (its sign-in under
  // way carries on); only a machine that's gone falls back to this one.
  const machine = chosen === LOCAL || machines.some((m) => m.id === chosen) ? chosen : LOCAL;
  const shown = machines.find((m) => m.id === machine);
  const name = shown?.name;
  const away = shown && !usable(shown.state) ? offlineWord(shown.state) : null;
  return (
    <section className="settings-pane" aria-label="Engines">
      <h1 className="display-lg">Engines</h1>
      <p className="muted small">The coding CLIs on the computer Desk’s sessions run on. Desk reads each one’s version and sign-in every hour.</p>
      {machines.length > 0 && (
        <div className="field">
          <span className="ov-label muted">On</span>
          <div className="chip-row" role="radiogroup" aria-label="On">
            <button type="button" role="radio" className="chip-btn" aria-checked={machine === LOCAL} aria-pressed={machine === LOCAL} onClick={() => setChosen(LOCAL)}>
              {thisComputer(platform)}
            </button>
            {machines.map((m) => {
              const off = offlineWord(m.state);
              const can = usable(m.state);
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  className="chip-btn"
                  aria-checked={machine === m.id}
                  aria-pressed={machine === m.id}
                  aria-disabled={!can || undefined}
                  title={can ? undefined : `${m.name} is ${off} right now`}
                  onClick={() => can && setChosen(m.id)}
                >
                  {m.name}
                  {off && ` · ${off}`}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {away && (
        <p className="small muted" role="status">
          {name} is {away} right now. What it said last stays here, and Desk carries on once it’s back.
        </p>
      )}
      <EngineBlocks key={machine} machine={machine} name={name} native={native} />
    </section>
  );
}
