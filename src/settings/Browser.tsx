import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserPill } from "../browser/BrowserPill";
import { CONNECT_POLL_MS, GET_CHROME, openChrome, TURN_ON } from "../browser/chrome";
import { backendLabel, useLocalBrowser } from "../browser/store";
import type { BrowserOf } from "../hub/browser";
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
  /** Opens the person's Chrome, or brings it forward. */
  openChrome?: () => Promise<void>;
  /** Puts `text` on the clipboard. */
  copy?: (text: string) => Promise<void>;
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
      ? { text: "Ready. Desk connects when it needs your Chrome, and Chrome asks you to Allow it first.", tone: "done" }
      : { text: `Desk can work in the Chrome you’re signed in to (Chrome ${c.min_version} or later). Connect it once and Chrome remembers.`, tone: "" };

/** The browser's settings and screenshots are the person's: asked of this
 *  computer's hub as them. Its activity is the computer's list. */
const hubApi = (browser: BrowserOf | null): BrowserApi | null => {
  const hub = useDesk.getState().hub;
  if (!hub || !browser) return null;
  return {
    settings: browser.settings,
    save: browser.save,
    activity: async () => (await hub.computerActivity({ kind: "browser" })).rows,
    shot: browser.shot,
  };
};

/** Settings → Browser: which browsers Desk uses, whether its own shows, the
 *  sites your Chrome may go to, and what Desk did in a browser, with the
 *  page as it looked after. */
export function Browser({ api: given }: { api?: BrowserApi }) {
  const hubReady = useDesk((s) => s.hub !== null);
  const browser = useLocalBrowser();
  const api = useMemo(() => given ?? (hubReady ? hubApi(browser) : null), [given, hubReady, browser]);
  const roster = useChat((s) => s.roster);
  const names = Object.fromEntries(roster.map((a) => [a.id, a.name]));
  const [view, setView] = useState<BrowserSettingsView | null | "failed" | "old">(null);
  const [rows, setRows] = useState<ComputerActivityRow[] | null | "failed">(null);
  const [allow, setAllow] = useState("");
  const [block, setBlock] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The guide to Chrome's switch is open, and what opening Chrome said. */
  const [connecting, setConnecting] = useState(false);
  const [noChrome, setNoChrome] = useState<string | null>(null);
  /** Whether the address is on the clipboard: said only when it is. */
  const [copied, setCopied] = useState(false);

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
  }, [api]);
  useEffect(reload, [reload]);

  // While the guide is open, Desk watches for Chrome's switch and says so.
  useEffect(() => {
    if (!connecting || !api) return;
    const t = setInterval(() => {
      api
        .settings()
        .then((v) => {
          if (!v.chrome.available) return;
          shown(v);
          setConnecting(false);
        })
        .catch(() => undefined);
    }, CONNECT_POLL_MS);
    return () => clearInterval(t);
  }, [connecting, api]);

  const copy = (text: string): Promise<void> =>
    Promise.resolve()
      .then(() => (api?.copy ?? ((t: string) => navigator.clipboard.writeText(t)))(text))
      .then(
        () => setCopied(true),
        () => setCopied(false),
      );
  const connect = async () => {
    setNoChrome(null);
    await copy(TURN_ON);
    try {
      await (api?.openChrome ?? openChrome)();
      setConnecting(true);
    } catch (e) {
      setNoChrome(plainError(e));
    }
  };

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
        Desk can use a web browser for you: its own, where it asks you to sign in when a site needs it, or your own Chrome, where you’re already
        signed in. Unless you let it act fully, it asks you before it clicks or types on a page.
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
              <span className="small muted">
                {usesOwn ? "On screen, so you can watch it. It shows from the next time it opens." : "Choose Desk’s own browser first."}
              </span>
            </span>
          </div>

          {usesChrome && chrome && (
            <>
              <h2 className="field-label">My Chrome</h2>
              <p className={`small ${chromeLine(chrome).tone === "done" ? "state-done" : "muted"}`}>{chromeLine(chrome).text}</p>
              {!chrome.available && !connecting && (
                <div className="browser-chrome-on">
                  <button type="button" className="btn btn-sm btn-signal" onClick={() => void connect()}>
                    Connect my Chrome
                  </button>
                </div>
              )}
              {noChrome && (
                <p className="small state-blocked" role="alert">
                  {noChrome}{" "}
                  <button type="button" className="link small" onClick={() => openUrl(GET_CHROME)}>
                    Get Chrome
                  </button>
                </p>
              )}
              {!chrome.available && connecting && (
                <div className="browser-connect" role="group" aria-label="Connect my Chrome">
                  <p className="small">Chrome is open. Two steps there, once:</p>
                  <ol className="browser-connect-steps small">
                    <li>
                      Click Chrome’s address bar, paste this address and press Return{copied ? " (Desk copied it)" : ""}:{" "}
                      <span className="chip">{TURN_ON}</span>{" "}
                      <button type="button" className="link small" onClick={() => void copy(TURN_ON)}>
                        {copied ? "Copy again" : "Copy"}
                      </button>
                    </li>
                    <li>Tick “Allow remote debugging for this browser instance”.</li>
                  </ol>
                  <p className="small muted">
                    <span className="dot dot-working" aria-hidden="true" /> Waiting for Chrome… Chrome remembers this, and asks you to Allow
                    Desk the first time it connects.
                  </p>
                  <button type="button" className="btn btn-sm" onClick={() => setConnecting(false)}>
                    Cancel
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
