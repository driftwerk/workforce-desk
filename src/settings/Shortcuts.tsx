import { SHORTCUTS } from "../shortcuts/keys";
import { ShortcutField } from "./ShortcutField";

/** Every keyboard shortcut Desk has, each with a recorder. */
export function Shortcuts() {
  return (
    <section className="settings-pane" aria-label="Shortcuts">
      <h1 className="display-lg">Keyboard shortcuts</h1>
      <p className="muted small">Click a shortcut, then press the keys you want.</p>
      <div className="set-group">
        <span className="set-label">From any app</span>
        {SHORTCUTS.filter((s) => s.scope === "global").map((s) => (
          <ShortcutField key={s.id} id={s.id} />
        ))}
      </div>
      <div className="set-group">
        <span className="set-label">While Desk is in front</span>
        {SHORTCUTS.filter((s) => s.scope === "app").map((s) => (
          <ShortcutField key={s.id} id={s.id} />
        ))}
      </div>
    </section>
  );
}
