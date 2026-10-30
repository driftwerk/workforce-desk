import { useEffect, useState } from "react";
import {
  clash,
  defaultShortcuts,
  isGlobal,
  pressed,
  refusal,
  scopeOf,
  SHORTCUTS,
  shortcutLabel,
  warning,
  type ShortcutId,
} from "../shortcuts/keys";
import { useShortcuts } from "../shortcuts/manager";
import { useSettings } from "./store";

/** One of Desk's shortcuts: what it does, a recorder to change it, a way back
 *  to the default, and — for one that works from any app — whether Desk got
 *  the keys. */
export function ShortcutField({ id }: { id: ShortcutId }) {
  const spec = SHORTCUTS.find((s) => s.id === id)!;
  const keys = useSettings((s) => s.keys);
  const value = keys[id];
  const fallback = defaultShortcuts()[id];
  const setShortcut = useSettings((s) => s.setShortcut);
  const status = useShortcuts((s) => (isGlobal(id) ? s.status[id] : null));
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState("");
  const [reason, setReason] = useState<string | null>(null);

  /** Saves `accel` unless another of Desk's shortcuts has it. */
  const take = (accel: string) => {
    const why = clash(keys, id, accel);
    setReason(why);
    if (!why) setShortcut(id, accel);
  };

  useEffect(() => {
    if (!recording) return;
    useShortcuts.setState({ recording: true });
    const stop = () => setRecording(false);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "keydown" && e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setReason(null);
        return stop();
      }
      const p = pressed(e);
      if (p.kind === "modifiers") return setHeld(p.label);
      if (e.type !== "keydown") return;
      if (p.kind === "unknown") return setReason("Desk can’t use that key — choose another");
      const why = refusal(p.accel, scopeOf(id)) ?? clash(keys, id, p.accel);
      if (why) return setReason(why);
      setReason(null);
      setShortcut(id, p.accel);
      stop();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", stop);
      setHeld("");
      useShortcuts.setState({ recording: false });
    };
  }, [recording, id, keys, setShortcut]);

  const caution = warning(value);
  return (
    <div className="setting-card">
      <span className="card-text">
        <b>{spec.name}</b>
        <span>{spec.about}</span>
        {reason ? (
          <span className="state-blocked" role="alert">
            {reason}
          </span>
        ) : recording ? (
          <span className="faint">Esc cancels</span>
        ) : status?.state === "taken" ? (
          <span className="state-blocked" role="alert">
            {status.message}
          </span>
        ) : (
          caution && <span className="state-working">{caution}</span>
        )}
      </span>
      {!recording && value !== fallback && (
        <button type="button" className="link small" onClick={() => take(fallback)}>
          Reset to {shortcutLabel(fallback)}
        </button>
      )}
      <button
        type="button"
        className={`btn shortcut-keys${recording ? " recording" : ""}`}
        aria-label={`${spec.name} shortcut`}
        aria-pressed={recording}
        onClick={() => {
          setReason(null);
          setRecording((r) => !r);
        }}
        onBlur={() => setRecording(false)}
      >
        {recording ? (held ? `${held}…` : "Press the keys…") : <kbd>{shortcutLabel(value)}</kbd>}
      </button>
    </div>
  );
}
