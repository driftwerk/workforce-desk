import { useEffect, useId, useState } from "react";
import { useHost } from "../shell/host";
import { LOCAL, useMachines, type MachineId } from "./engines";
import { listFolders, splitTyped, suggest, type Folder } from "./folders";
import type { MachineNative } from "./native";
import { offlineWord, thisComputer, usable } from "./words";

/** New session's "Run on": this computer and each machine; one that can't
 *  take a session now is shown, and can't be chosen. Only once there's a
 *  machine. */
export function RunOn({ value, onChange }: { value: MachineId; onChange: (m: MachineId) => void }) {
  const machines = useMachines((s) => s.machines);
  const platform = useHost((h) => h.platform);
  if (!machines.length) return null;
  return (
    <div className="field">
      <span className="ov-label muted">Run on</span>
      <div className="chip-row" role="radiogroup" aria-label="Run on">
        <button type="button" role="radio" className="chip-btn" aria-checked={value === LOCAL} aria-pressed={value === LOCAL} onClick={() => onChange(LOCAL)}>
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
              aria-disabled={!can || undefined}
              title={can ? undefined : `${m.name} is ${off} right now`}
              onClick={() => can && onChange(m.id)}
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

/** How long typing rests before the machine is asked for its folders. */
export const FOLDERS_DEBOUNCE_MS = 200;

/** "Folder on devbox": typed, as the machine's own path, with the folders
 *  there that it could be. */
export function MachineFolder({
  machine,
  name,
  native,
  value,
  onChange,
}: {
  machine: MachineId;
  name: string;
  native: Pick<MachineNative, "transport">;
  value: string;
  onChange: (path: string) => void;
}) {
  const id = useId();
  const [folders, setFolders] = useState<Folder[]>([]);
  const dir = splitTyped(value).dir;
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      listFolders(native.transport(machine), dir)
        .then((f) => live && setFolders(f))
        .catch(() => live && setFolders([]));
    }, FOLDERS_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [machine, dir, native]);
  const shown = suggest(folders, value);
  return (
    <div className="field">
      <label htmlFor={id} className="ov-label muted">
        Folder on {name}
      </label>
      <input
        id={id}
        className="field-text mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="~/src/repo"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        required
      />
      {shown.length > 0 && (
        <ul className="folder-suggestions" aria-label={`Folders on ${name}`}>
          {shown.map((f) => (
            <li key={f.path}>
              <button type="button" className="folder-suggestion mono small" onClick={() => onChange(f.path)}>
                {f.path}
                {f.git && <span className="faint"> git</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
