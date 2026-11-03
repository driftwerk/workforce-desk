import { stopShowingImagesFrom, useSettings } from "./store";

export function Chat() {
  const { emoticons, imageSites, set } = useSettings();
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
      <div className="set-group">
        <b>Pictures from the web</b>
        <span className="muted small">
          A picture an agent links to waits for you to click Show image, and Desk fetches it then. Showing one tells its
          site your IP address. Pictures from these sites show straight away:
        </span>
        {imageSites.length ? (
          <ul className="image-sites" aria-label="Sites whose pictures always show">
            {imageSites.map((site) => (
              <li key={site} className="image-site">
                <span>{site}</span>
                <button
                  type="button"
                  className="btn att-btn"
                  aria-label={`Stop always showing pictures from ${site}`}
                  onClick={() => stopShowingImagesFrom(site)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="small faint">None yet. Choose “Always show from this site” under a picture to add one.</span>
        )}
      </div>
    </section>
  );
}
