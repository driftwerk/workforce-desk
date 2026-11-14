import { useHost } from "../shell/host";
import { LOCAL, useMachines, type MachineId } from "./engines";
import { offlineWord, thisComputer, usable } from "./words";

/** New session's "Run on": this computer and each machine; one that can't
 *  take a session now is shown, and can't be chosen. Only once there's a
 *  machine. `label` names it where there are several (a plan's tickets). */
export function RunOn({ value, onChange, label = "Run on", disabled = false }: { value: MachineId; onChange: (m: MachineId) => void; label?: string; disabled?: boolean }) {
  const machines = useMachines((s) => s.machines);
  const platform = useHost((h) => h.platform);
  if (!machines.length) return null;
  return (
    <div className="field">
      <span className="ov-label muted">Run on</span>
      <div className="chip-row" role="radiogroup" aria-label={label}>
        <button
          type="button"
          role="radio"
          className="chip-btn"
          aria-checked={value === LOCAL}
          aria-pressed={value === LOCAL}
          aria-disabled={disabled || undefined}
          onClick={() => !disabled && onChange(LOCAL)}
        >
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
              aria-checked={value === m.id}
              aria-pressed={value === m.id}
              aria-disabled={!can || disabled || undefined}
              title={can ? undefined : `${m.name} is ${off} right now`}
              onClick={() => can && !disabled && onChange(m.id)}
            >
              {m.name}
              {off && ` · ${off}`}
            </button>
          );
        })}
      </div>
    </div>
  );
}
