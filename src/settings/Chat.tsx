import { SwitchRow } from "../ui/SwitchRow";
import { stopShowingImagesFrom, useSettings } from "./store";

export function Chat() {
  const { emoticons, imageSites, set } = useSettings();
  return (
    <section className="settings-pane" aria-label="Chat">
      <h1 className="display-lg">Chat</h1>
      <SwitchRow
        label="Turn emoticons into emoji as you type"
        sub={
          "<3 becomes ❤️ and :) becomes 🙂 once you type a space or punctuation after them, or send. Never in code or a link; Backspace straight after puts back what you typed. :shortcodes like :tada: and the emoji button work either way."
        }
        on={emoticons}
        onChange={(on) => set({ emoticons: on })}
      />
      <section className="prov-section" aria-label="Pictures from the web">
        <h2 className="field-label">Pictures from the web</h2>
        <span className="muted small">
          A picture an agent links to waits for you to click Show image, and Desk fetches it then. Showing one tells its
          site your IP address. Pictures from these sites show straight away (up to ten a message):
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
        <span className="small faint">
          Best left off: sites where anyone can post a picture (image hosts, forums, chat apps), since then anyone can
          choose what Desk fetches.
        </span>
      </section>
    </section>
  );
}
