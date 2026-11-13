import { SHORTCUTS } from "../shortcuts/keys";
import { ShortcutField } from "./ShortcutField";

/** Every keyboard shortcut Desk has, each with a recorder. */
export function Shortcuts() {
  return (
    <section className="settings-pane" aria-label="Shortcuts">
      <h1 className="display-lg">Keyboard shortcuts</h1>
      <p className="muted">Click a shortcut, then press the keys you want.</p>
      <section className="prov-section" aria-label="From any app">
        <h2 className="field-label">From any app</h2>
        <div className="prov-list">
          {SHORTCUTS.filter((s) => s.scope === "global").map((s) => (
            <ShortcutField key={s.id} id={s.id} />
          ))}
        </div>
      </section>
      <section className="prov-section" aria-label="While Desk is in front">
        <h2 className="field-label">While Desk is in front</h2>
        <div className="prov-list">
          {SHORTCUTS.filter((s) => s.scope === "app").map((s) => (
            <ShortcutField key={s.id} id={s.id} />
          ))}
        </div>
      </section>
    </section>
  );
}
