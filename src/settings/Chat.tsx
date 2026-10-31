import { useSettings } from "./store";

export function Chat() {
  const { emoticons, set } = useSettings();
  return (
    <section className="settings-pane" aria-label="Chat">
      <h1 className="display-lg">Chat</h1>
      <label className="toggle-row">
        <input type="checkbox" checked={emoticons} onChange={(e) => set({ emoticons: e.target.checked })} />
        <span>
          <b>Turn emoticons into emoji as you type</b>
          <span className="muted small">
            {"<3 becomes ❤️ and :) becomes 🙂 once you type a space or punctuation after them, or send. Never in code or a link; Backspace straight after puts back what you typed. :shortcodes like :tada: and the emoji button work either way."}
          </span>
        </span>
      </label>
    </section>
  );
}
