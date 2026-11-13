import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserPill } from "../browser/BrowserPill";
import { useLocalBrowser } from "../browser/store";
import type { BrowserOf } from "../hub/browser";
import { useChat } from "../chat/store";
import { outcomeOf, whenText } from "../computer/access";
import { HubError, type BrowserSettings, type BrowserSettingsView, type ChromeProfile, type ComputerActivityRow } from "../hub/client";
import { useDesk } from "../hub/store";
import { openUrl } from "../platform";
import { plainError } from "../ui/plainError";
import "../styles/computer.css";
import "../styles/browser.css";
import { SwitchRow } from "../ui/SwitchRow";

/** What Settings → Browser reads and changes. */
export interface BrowserApi {
  settings: () => Promise<BrowserSettingsView>;
  save: (s: BrowserSettings) => Promise<BrowserSettingsView>;
  /** The person confirms a Chrome profile is theirs, chooses the one Desk
   *  uses, or forgets one. */
  confirm: (id: string) => Promise<BrowserSettingsView>;
  choose: (id: string) => Promise<BrowserSettingsView>;
  forget: (id: string) => Promise<BrowserSettingsView>;
  activity: () => Promise<ComputerActivityRow[]>;
  shot: (file: string) => Promise<Blob>;
}

/** How often the page asks whether Desk's extension has connected. */
export const WATCH_MS = 2000;

/** A site list as the person writes it: hosts, by commas, spaces or lines. */
export const sitesOf = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s, i, all) => s !== "" && all.indexOf(s) === i);

/** How Desk's extension stands, in a line. */
export const chromeLine = (c: BrowserSettingsView["chrome"]): { text: string; tone: "done" | "blocked" | "" } => {
  const pending = c.profiles.some((p) => p.state === "pending" && p.connected);
  if (pending) return { text: "A Chrome is asking to connect. Check its code below, then confirm it.", tone: "blocked" };
  if (c.connected) return { text: "Connected. Desk works in a window of its own in your Chrome, signed in as you.", tone: "done" };
  if (c.profiles.some((p) => p.state === "confirmed")) return { text: "Not connected now: open Chrome and Desk connects by itself.", tone: "" };
  return { text: "Add Desk to Chrome, and Desk can work in your own Chrome, where you’re already signed in.", tone: "" };
};

/** The browser's settings and screenshots are the person's: asked of this
 *  computer's hub as them. Its activity is the computer's list. */
const hubApi = (browser: BrowserOf | null): BrowserApi | null => {
  const hub = useDesk.getState().hub;
  if (!hub || !browser) return null;
  return {
    settings: browser.settings,
    save: browser.save,
    confirm: browser.confirm,
    choose: browser.choose,
    forget: browser.forget,
    activity: async () => (await hub.computerActivity({ kind: "browser" })).rows,
    shot: browser.shot,
  };
};

/** Settings → Browser: whether Desk uses your Chrome, Desk's extension and
 *  the Chrome profiles it connects from, the sites it may go to, and what
 *  it did there, with the page as it looked after. */
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

  /** Takes a view; the site lists only when the person isn't editing them. */
  const shown = useCallback((v: BrowserSettingsView, sites = true) => {
    setView(v);
    if (sites) {
      setAllow(v.settings.sites.allow.join(", "));
      setBlock(v.settings.sites.block.join(", "));
    }
  }, []);
  const reload = useCallback(() => {
    if (!api) return;
    api
      .settings()
      .then((v) => shown(v))
      .catch((e: unknown) => setView(e instanceof HubError && e.status === 404 ? "old" : "failed"));
    api
      .activity()
      .then(setRows)
      .catch(() => setRows("failed"));
  }, [api, shown]);
  useEffect(reload, [reload]);

  // Desk watches for its extension connecting, and for a profile asking to
  // be confirmed; only Chrome's standing is taken from what it reads.
  useEffect(() => {
    if (!api) return;
    const t = setInterval(() => {
      api
        .settings()
        .then((v) => setView((now) => (now && typeof now === "object" ? { ...now, chrome: v.chrome } : v)))
        .catch(() => undefined);
    }, WATCH_MS);
    return () => clearInterval(t);
  }, [api]);

  const act = async (f: () => Promise<BrowserSettingsView>, sites = false) => {
    setBusy(true);
    setProblem(null);
    try {
      shown(await f(), sites);
    } catch (e) {
      setProblem(plainError(e));
    }
    setBusy(false);
  };

  if (!api) {
    return (
      <section className="settings-pane" aria-label="Browser">
        <h1 className="display-lg">Browser</h1>
        <p className="faint small">Desk isn’t ready yet.</p>
      </section>
    );
  }
  const s = view && typeof view === "object" ? view.settings : null;
  const chrome = view && typeof view === "object" ? view.chrome : null;
  const sitesChanged = s !== null && (sitesOf(allow).join() !== s.sites.allow.join() || sitesOf(block).join() !== s.sites.block.join());
  const pending = chrome?.profiles.filter((p) => p.state === "pending" && p.connected) ?? [];
  const confirmed = chrome?.profiles.filter((p) => p.state === "confirmed") ?? [];
  const line = chrome ? chromeLine(chrome) : null;

  return (
    <section className="settings-pane" aria-label="Browser">
      <h1 className="display-lg">Browser</h1>
      <p className="muted">
        Desk works in your own Chrome, where you’re already signed in, through Desk’s Chrome extension: in a window of its own, never in your other
        tabs. Unless you let it act fully, it asks you before it clicks or types on a page.
      </p>
      <BrowserPill place="band" />
      {view === "old" ? (
        <p className="faint small">This version of Desk doesn’t have the browser yet. Update Desk to use it.</p>
      ) : view === "failed" ? (
        <p className="state-blocked small">Couldn’t read the browser settings just now.</p>
      ) : !s || !chrome || view === null ? (
        <p className="faint small">Reading…</p>
      ) : (
        <>
          <SwitchRow
            label="Desk uses your Chrome"
            sub={s.on ? "Agents can open pages, read them and, as you allow, act on them." : "Off: no agent uses a browser, and Desk’s window closes."}
            on={s.on}
            saving={busy}
            onChange={(on) => void act(() => api.save({ ...s, on }))}
          />

          <h2 className="field-label">Desk in Chrome</h2>
          {line && <p className={`small ${line.tone === "done" ? "state-done" : line.tone === "blocked" ? "state-blocked" : "muted"}`}>{line.text}</p>}
          {pending.length > 1 && (
            <p className="small state-blocked" role="alert">
              More than one Chrome is asking at once. Unless you just added Desk’s extension in each of them, choose Not mine for every one: something
              else on this computer may be asking.
            </p>
          )}
          {pending.map((p) => (
            <ConfirmProfile
              key={p.id}
              profile={p}
              using={confirmed.find((c) => c.chosen) ?? null}
              busy={busy}
              onConfirm={() => void act(() => api.confirm(p.id))}
              onRefuse={() => void act(() => api.forget(p.id))}
            />
          ))}
          {confirmed.length === 0 && pending.length === 0 && <AddToChrome storeUrl={chrome.store_url} />}
          {confirmed.length > 0 && (
            <ul className="browser-profiles" aria-label="Chrome profiles">
              {confirmed.map((p) => (
                <li key={p.id} className="browser-profile">
                  <span className={`dot ${p.connected ? "dot-done" : "dot-idle"}`} aria-hidden="true" />
                  <span className="browser-profile-text">
                    <span className="small">
                      Chrome <code className="mono">{p.label}</code>
                      {p.chosen && confirmed.length > 1 ? " · Desk uses this one" : ""}
                    </span>
                    <span className="small faint">
                      {p.connected ? "Connected" : "Not connected now"} · extension {p.version}
                    </span>
                  </span>
                  {!p.chosen && (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act(() => api.choose(p.id))}>
                      Use this one
                    </button>
                  )}
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void act(() => api.forget(p.id))}>
                    Forget
                  </button>
                </li>
              ))}
            </ul>
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
            onClick={() => void act(() => api.save({ ...s, sites: { allow: sitesOf(allow), block: sitesOf(block) } }), true)}
          >
            Save sites
          </button>
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

/** A Chrome profile asking to connect: the person checks its code matches
 *  the one Desk's extension shows in that Chrome, then confirms it. Until
 *  then it reaches nothing. */
function ConfirmProfile({
  profile,
  using,
  busy,
  onConfirm,
  onRefuse,
}: {
  profile: ChromeProfile;
  /** The Chrome Desk uses now, which stays the one it uses. */
  using: ChromeProfile | null;
  busy: boolean;
  onConfirm: () => void;
  onRefuse: () => void;
}) {
  return (
    <div className="browser-connect" role="group" aria-label="A Chrome asks to connect">
      <p className="small">
        <b>A Chrome asks to connect to Desk</b>
      </p>
      <p className="small">
        Its code is <code className="mono browser-code">{profile.label}</code>. Click Desk’s icon in that Chrome’s toolbar: confirm only if it shows
        the same code.
      </p>
      <p className="small faint">
        It says it’s extension {profile.version}: only the code shows it’s Desk’s. Once confirmed, Desk can open pages in that Chrome, signed in as
        you.
      </p>
      {using && (
        <p className="small muted">
          Desk keeps using Chrome <code className="mono">{using.label}</code>. To switch to this one once it’s confirmed, choose Use this one.
        </p>
      )}
      <div className="browser-connect-actions">
        <button type="button" className="btn btn-sm btn-signal" disabled={busy} onClick={onConfirm}>
          It’s my Chrome
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onRefuse}>
          Not mine
        </button>
      </div>
    </div>
  );
}

/** Getting Desk's extension: from the Chrome Web Store; in a development
 *  build, loaded unpacked. */
function AddToChrome({ storeUrl }: { storeUrl: string | null }) {
  return (
    <div className="browser-add">
      {storeUrl ? (
        <button type="button" className="btn btn-sm btn-signal" onClick={() => openUrl(storeUrl)}>
          Add Desk to Chrome
        </button>
      ) : (
        <p className="small muted">Desk’s extension isn’t in the Chrome Web Store yet.</p>
      )}
      {import.meta.env.DEV && (
        <p className="small faint">
          Development build: in Chrome open <code className="mono">chrome://extensions</code>, turn on Developer mode, press Load unpacked and choose
          this repository’s <code className="mono">extension/dist</code> (built with <code className="mono">npm run extension</code>).
        </p>
      )}
      <p className="small faint">Desk finds it by itself once it’s added: nothing to set up here.</p>
    </div>
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
        </span>
        <span className="mono small" title={row.arguments?.url ?? row.doing}>
          {row.doing}
        </span>
      </span>
      <span className={`computer-chip small ${o?.tone ?? ""}`}>{o?.text ?? ""}</span>
    </li>
  );
}
