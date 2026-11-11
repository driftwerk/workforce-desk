import { useCallback, useEffect, useState } from "react";
import { BrowserPill } from "../browser/BrowserPill";
import { backendLabel } from "../browser/store";
import { useChat } from "../chat/store";
import { outcomeOf, whenText } from "../computer/access";
import { HubError, type BrowserSettings, type BrowserSettingsView, type BrowserUses, type ComputerActivityRow } from "../hub/client";
import { useDesk } from "../hub/store";
import { openUrl } from "../platform";
import { plainError } from "../ui/plainError";
import "../styles/computer.css";
import "../styles/browser.css";

/** What Settings → Browser reads and changes. */
export interface BrowserApi {
  settings: () => Promise<BrowserSettingsView>;
  save: (s: BrowserSettings) => Promise<BrowserSettingsView>;
  activity: () => Promise<ComputerActivityRow[]>;
  shot: (file: string) => Promise<Blob>;
}

/** Which browsers Desk uses, as the setting offers them. */
export const USES: { id: BrowserUses; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "desk", label: "Desk’s own browser" },
  { id: "chrome", label: "My Chrome" },
  { id: "both", label: "Both" },
];

/** A site list as the person writes it: hosts, by commas, spaces or lines. */
export const sitesOf = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s, i, all) => s !== "" && all.indexOf(s) === i);

/** How the person's Chrome stands, in a line. */
export const chromeLine = (c: BrowserSettingsView["chrome"]): { text: string; tone: "done" | "" } =>
  c.connected
    ? { text: "Connected. Desk is working in a window of its own in your Chrome.", tone: "done" }
    : c.available
      ? { text: "Not connected. Remote debugging is on, so Desk connects when it needs to, and Chrome asks you first.", tone: "" }
      : { text: `Not connected. Turn on remote debugging in Chrome ${c.min_version} or later so Desk can use it.`, tone: "" };

const hubApi = (): BrowserApi | null => {
  const hub = useDesk.getState().hub;
  if (!hub) return null;
  return {
    settings: () => hub.browserSettings(),
    save: (s) => hub.setBrowserSettings(s),
    activity: async () => (await hub.computerActivity({ kind: "browser" })).rows,
    shot: (f) => hub.browserShot(f),
  };
};

/** Settings → Browser: which browsers Desk uses, whether its own shows, the
 *  sites your Chrome may go to, and what Desk did in a browser, with the
 *  page as it looked after. */
export function Browser({ api: given }: { api?: BrowserApi }) {
  const hubReady = useDesk((s) => s.hub !== null);
  const api = given ?? (hubReady ? hubApi() : null);
  const roster = useChat((s) => s.roster);
  const names = Object.fromEntries(roster.map((a) => [a.id, a.name]));
  const [view, setView] = useState<BrowserSettingsView | null | "failed" | "old">(null);
  const [rows, setRows] = useState<ComputerActivityRow[] | null | "failed">(null);
  const [allow, setAllow] = useState("");
  const [block, setBlock] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const shown = (v: BrowserSettingsView) => {
    setView(v);
    setAllow(v.settings.sites.allow.join(", "));
    setBlock(v.settings.sites.block.join(", "));
  };
  const reload = useCallback(() => {
    if (!api) return;
    api
      .settings()
      .then(shown)
      .catch((e: unknown) => setView(e instanceof HubError && e.status === 404 ? "old" : "failed"));
    api
      .activity()
      .then(setRows)
      .catch(() => setRows("failed"));
  }, [hubReady, given]);
  useEffect(reload, [reload]);

  const save = async (next: BrowserSettings) => {
    if (!api) return;
    setBusy(true);
    setProblem(null);
    try {
      shown(await api.save(next));
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };

  if (!api) {
    return (
      <section className="settings-pane" aria-label="Browser">
        <h1 className="display-lg">Browser</h1>
        <p className="faint small">Not connected to a hub.</p>
      </section>
    );
  }
  const s = view && typeof view === "object" ? view.settings : null;
  const chrome = view && typeof view === "object" ? view.chrome : null;
  const usesChrome = s?.use === "chrome" || s?.use === "both";
  const usesOwn = s?.use === "desk" || s?.use === "both";
  const sitesChanged = s !== null && (sitesOf(allow).join() !== s.sites.allow.join() || sitesOf(block).join() !== s.sites.block.join());

  return (
    <section className="settings-pane" aria-label="Browser">
      <h1 className="display-lg">Browser</h1>
      <p className="muted small">
        Desk can use a web browser for you: its own, which you sign in to once by hand, or your own Chrome, where you’re already signed in. Below
        unbound it asks you before it clicks or types on a page.
      </p>
      <BrowserPill place="band" />
      {view === "old" ? (
        <p className="faint small">This hub doesn’t have the browser yet.</p>
      ) : view === "failed" ? (
        <p className="state-blocked small">Couldn’t read the browser settings just now.</p>
      ) : !s || view === null ? (
        <p className="faint small">Reading…</p>
      ) : (
        <>
          <h2 className="field-label">Desk uses</h2>
          <div className="effort-seg" role="radiogroup" aria-label="Desk uses">
            {USES.map((u) => (
              <button key={u.id} type="button" role="radio" aria-checked={s.use === u.id} disabled={busy} onClick={() => void save({ ...s, use: u.id })}>
                {u.label}
              </button>
            ))}
          </div>
          {s.use === "off" && <p className="small muted">Off, no agent uses a browser, and one open now closes.</p>}

          <div className="toggle-row">
            <input
              id="browser-show"
              type="checkbox"
              checked={s.show !== false}
              disabled={busy || !usesOwn}
              onChange={(e) => void save({ ...s, show: e.target.checked })}
            />
            <span>
              <label htmlFor="browser-show">Show Desk’s browser</label>
              <span className="small muted">On screen, so you can watch it and sign in to a site once by hand. It shows from the next time it opens.</span>
            </span>
          </div>

          {usesChrome && chrome && (
            <>
              <h2 className="field-label">My Chrome</h2>
              <p className={`small ${chromeLine(chrome).tone === "done" ? "state-done" : "muted"}`}>{chromeLine(chrome).text}</p>
              {!chrome.connected && (
                <div className="browser-chrome-on">
                  <span className="chip">{chrome.turn_on}</span>
                  <button type="button" className="btn btn-sm" onClick={() => openUrl(chrome.turn_on)}>
                    Open in Chrome
                  </button>
                </div>
              )}
              <label className="field browser-sites">
                <span>Only these sites (leave empty for any)</span>
                <input value={allow} placeholder="example.com, docs.example.com" onChange={(e) => setAllow(e.target.value)} />
              </label>
              <label className="field browser-sites">
                <span>Never these sites</span>
                <input value={block} placeholder="bank.example" onChange={(e) => setBlock(e.target.value)} />
              </label>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || !sitesChanged}
                onClick={() => void save({ ...s, sites: { allow: sitesOf(allow), block: sitesOf(block) } })}
              >
                Save sites
              </button>
            </>
          )}
          {problem && (
            <p className="small state-blocked" role="alert">
              {problem}
            </p>
          )}
        </>
      )}

      <h2 className="field-label">What it did</h2>
      {rows === "failed" ? (
        <p className="small state-blocked">Couldn’t read what the browser did just now.</p>
      ) : rows === null ? (
        <p className="small faint">Reading…</p>
      ) : rows.length === 0 ? (
        <p className="pane-empty small">Nothing yet. When an agent opens a page or clicks or types in one, it shows here with the page as it looked.</p>
      ) : (
        <ul className="computer-list" aria-label="What the browser did">
          {rows.map((r) => (
            <BrowserRow key={r.id} row={r} name={names[r.agent] ?? r.agent} shot={api.shot} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One thing a browser did, with a thumbnail of the page after. */
function BrowserRow({ row, name, shot }: { row: ComputerActivityRow; name: string; shot: BrowserApi["shot"] }) {
  const file = row.arguments?.screenshot ?? null;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    let url: string | null = null;
    let gone = false;
    shot(file)
      .then((b) => {
        if (gone) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => {});
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, shot]);
  const o = outcomeOf(row);
  const backend = row.arguments?.backend;
  return (
    <li className="computer-row">
      {file &&
        (src ? (
          <a className="browser-thumb" href={src} target="_blank" rel="noreferrer" aria-label="The page after">
            <img src={src} alt="" />
          </a>
        ) : (
          <span className="browser-thumb" aria-hidden="true" />
        ))}
      <span className="computer-row-text">
        <span className="small faint">
          {whenText(row.at)} · {name}
          {backend ? ` · ${backendLabel(backend)}` : ""}
        </span>
        <span className="mono small" title={row.arguments?.url ?? row.doing}>
          {row.doing}
        </span>
      </span>
      <span className={`computer-chip small ${o?.tone ?? ""}`}>{o?.text ?? ""}</span>
    </li>
  );
}
