import { useEffect, useState } from "react";
import { DEFAULT_SHORTCUTS, normalize, pressed, refusal, SHORTCUT_NAMES, shortcutLabel, type ShortcutId } from "../shortcuts/keys";
import { useShortcuts } from "../shortcuts/manager";
import { useSettings } from "./store";

const FIELD = { pushToTalk: "pushToTalkShortcut", ask: "askShortcut" } as const satisfies Record<ShortcutId, string>;

const OTHER: Record<ShortcutId, ShortcutId> = { pushToTalk: "ask", ask: "pushToTalk" };

/** One of Desk's global shortcuts: what it is, a recorder to change it, and
 *  whether Desk got the keys. */
export function ShortcutField({ id, about }: { id: ShortcutId; about: string }) {
  const value = useSettings((s) => s[FIELD[id]]);
  const other = useSettings((s) => s[FIELD[OTHER[id]]]);
  const setSettings = useSettings((s) => s.set);
  const status = useShortcuts((s) => s.status[id]);
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState("");
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    const save = (accel: string) => setSettings(id === "ask" ? { askShortcut: accel } : { pushToTalkShortcut: accel });
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
      const why =
        refusal(p.accel) ??
        (p.accel === normalize(other) ? `${shortcutLabel(p.accel)} is already ${SHORTCUT_NAMES[OTHER[id]]} — choose another` : null);
      if (why) return setReason(why);
      setReason(null);
      save(p.accel);
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
  }, [recording, id, other, setSettings]);

  return (
    <div className="setting-card">
      <span className="card-text">
        <b>{SHORTCUT_NAMES[id]}</b>
        <span>{about}</span>
        {reason ? (
          <span className="state-blocked" role="alert">
            {reason}
          </span>
        ) : recording ? (
          <span className="faint">Esc cancels</span>
        ) : (
          status.state === "taken" && (
            <span className="state-blocked" role="alert">
              {status.message}
            </span>
          )
        )}
      </span>
      {!recording && value !== DEFAULT_SHORTCUTS[id] && DEFAULT_SHORTCUTS[id] !== normalize(other) && (
        <button
          type="button"
          className="link small"
          onClick={() => setSettings(id === "ask" ? { askShortcut: DEFAULT_SHORTCUTS.ask } : { pushToTalkShortcut: DEFAULT_SHORTCUTS.pushToTalk })}
        >
          Use {shortcutLabel(DEFAULT_SHORTCUTS[id])}
        </button>
      )}
      <button
        type="button"
        className={`btn shortcut-keys${recording ? " recording" : ""}`}
        aria-label={`${SHORTCUT_NAMES[id]} shortcut`}
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
