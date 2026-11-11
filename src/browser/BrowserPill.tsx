import { useUi } from "../shell/ui";
import { backendLabel, useBrowser, useLocalBrowser } from "./store";
import "../styles/browser.css";

/** "Desk is using the browser": the page it is on and which browser, with
 *  Stop. In the title bar for every agent, on the overseer's Floor card for
 *  its own (`agent`). Opening it shows what the browser did. */
export function BrowserPill({ agent, place }: { agent?: string; place: "titlebar" | "band" | "card" }) {
  const browser = useLocalBrowser();
  const all = useBrowser((s) => s.live);
  const stopping = useBrowser((s) => s.stopping);
  const problem = useBrowser((s) => s.problem);
  const live = all.filter((l) => !agent || l.agent === agent);
  const [now] = live;
  if (!browser || !now) return null;
  const more = live.length - 1;
  return (
    <div className={`browser-pill browser-pill-${place}`} role="status" aria-label="Desk is using the browser" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="chip browser-pill-open"
        title="See what it did in the browser"
        onClick={() => useUi.getState().openSettings("browser")}
      >
        <span className="dot dot-working" aria-hidden="true" />
        <span>Desk is using the browser</span>
        <span className="faint">· {now.host ?? "a blank page"}</span>
        <span className="faint">· {backendLabel(now.backend)}</span>
        {more > 0 && <span className="faint">· {more} more</span>}
      </button>
      <button type="button" className="btn btn-sm btn-danger" disabled={stopping} onClick={() => void useBrowser.getState().stop(browser, agent)}>
        {stopping ? "Stopping…" : "Stop"}
      </button>
      {problem && (
        <span className="small state-blocked" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}
