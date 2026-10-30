import { getVersion } from "@tauri-apps/api/app";
import { save } from "@tauri-apps/plugin-dialog";
import { exit } from "@tauri-apps/plugin-process";
import { useEffect, useState } from "react";
import {
  fixWslForwarding,
  helperStatus,
  inApp,
  openLoginItems,
  removeDeskData,
  saveReport,
  wslBackendVersion,
  type HelperStatus,
} from "../platform";
import { useSetup } from "../setup/store";
import { problemText } from "../setup/wsl";
import { useHost, type BackendHost, type Platform } from "../shell/host";
import { CloseButton, Dialog } from "../ui/Dialog";
import { useUpdates } from "../updates/store";

/** Where each system lists what starts at login. */
export const STARTUP: Record<Platform, string> = { macos: "Login Items", windows: "Startup apps", linux: "your session’s autostart" };

/** The button that opens it, where Desk can open it. */
const OPEN_STARTUP: Record<Platform, string | null> = { macos: "Open Login Items", windows: "Open Startup apps", linux: null };

/** What the helper's state means, in the person's words. */
export const helperLine = (s: HelperStatus | null, platform: Platform): string => {
  switch (s?.state) {
    case undefined:
      return "…";
    case "running":
      return "Running. It keeps your agents and sessions going while this window is closed.";
    case "needs-approval":
      return `Turned off in ${STARTUP[platform]}, so your agents stop when Desk quits.`;
    case "not-registered":
      return "Not set up yet.";
    case "move-to-applications":
      return "Move Desk to your Applications folder, then open it from there.";
    case "development":
      return "Started by hand (a development build).";
    case "no-wsl":
      return `${problemText(s.problem)}.`;
    case "starting":
      return "Starting…";
    case "port-unreachable":
      return "Running in WSL, but Windows can’t reach it.";
    case "failed":
      return s.message;
  }
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Settings → Help: the version, a report to send, and removing Desk. */
/** Settings → Help on Windows: the distro Desk runs in, the backend's
 *  version there, and setting Desk up (again, or in another distro). */
function WhereDeskRuns({ host, helper }: { host: BackendHost | null; helper: HelperStatus | null }) {
  const show = useSetup((s) => s.show);
  const [version, setVersion] = useState<string | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const distro = host?.kind === "wsl" ? host.distro : null;
  useEffect(() => {
    if (distro) void wslBackendVersion().then(setVersion, () => setVersion(null));
  }, [distro]);
  const fix = async () => {
    if (!distro) return;
    setFixing("Restarting WSL…");
    try {
      await fixWslForwarding(distro);
      setFixing("Fixed. Windows reaches Desk again.");
    } catch (e) {
      setFixing(errorText(e));
    }
  };
  return (
    <div className="setting-card">
      <span className="card-text">
        <b>Where Desk runs</b>
        <span>
          {distro
            ? `${distro} (WSL 2)${version ? ` · Desk ${version} there` : ""}. Moving to another Linux sets Desk up afresh there; what Desk keeps in ${distro} stays where it is.`
            : "Not set up yet: this computer’s agents and sessions run in Linux, inside WSL."}
        </span>
        {helper?.state === "port-unreachable" && (
          <span className="state-blocked">
            WSL isn’t passing Desk’s port to Windows. Turning on <code>localhostForwarding=true</code> in <code>[wsl2]</code> of
            .wslconfig fixes it, and restarts WSL. {fixing}
          </span>
        )}
      </span>
      {helper?.state === "port-unreachable" && (
        <button type="button" className="btn" onClick={() => void fix()}>
          Fix it and restart WSL
        </button>
      )}
      <button type="button" className="btn" onClick={show}>
        {distro ? "Use another Linux…" : "Set up…"}
      </button>
    </div>
  );
}

export function Help() {
  const { platform, keys, host } = useHost();
  const openStartup = OPEN_STARTUP[platform];
  const [version, setVersion] = useState("");
  const [helper, setHelper] = useState<HelperStatus | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const update = useUpdates((s) => s.state);
  const check = useUpdates((s) => s.check);
  const [checked, setChecked] = useState<string | null>(null);

  useEffect(() => {
    if (!inApp) return;
    void getVersion().then(setVersion);
    void helperStatus().then(setHelper, (e: unknown) => setHelper({ state: "failed", message: errorText(e) }));
  }, []);

  const sendReport = async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await save({ defaultPath: `Desk report ${stamp}.zip`, filters: [{ name: "Zip", extensions: ["zip"] }] });
    if (!path) return;
    setReport("Saving…");
    try {
      await saveReport(path, `Desk ${version}`);
      setReport("Saved. Passwords, keys and tokens were taken out — send it to whoever is helping you.");
    } catch (e) {
      setReport(`Couldn’t save the report: ${errorText(e)}`);
    }
  };

  const checkNow = async () => {
    setChecked("Checking…");
    try {
      await check();
      const s = useUpdates.getState().state;
      setChecked(s.phase === "idle" ? "Desk is up to date." : null);
    } catch (e) {
      setChecked(`Couldn’t check for updates: ${errorText(e)}`);
    }
  };

  return (
    <section className="settings-pane" aria-label="Help">
      <h1 className="display-lg">Help</h1>

      <div className="setting-card">
        <span className="card-text">
          <b>Desk {version}</b>
          <span>
            {update.phase === "available"
              ? `Desk ${update.version} is out. Your package manager installs it, or download it from the releases page.`
              : update.phase === "downloading"
                ? `Downloading Desk ${update.version}…`
                : update.phase === "ready"
                  ? `Desk ${update.version} is ready — restart to update.`
                  : (checked ?? "Desk updates itself.")}
          </span>
        </span>
        <button type="button" className="btn" disabled={!inApp || update.phase !== "idle"} onClick={() => void checkNow()}>
          Check for updates
        </button>
      </div>

      <div className="setting-card">
        <span className="card-text">
          <b>Desk Helper</b>
          <span className={helper?.state === "running" ? undefined : "state-blocked"}>{helperLine(helper, platform)}</span>
        </span>
        {helper?.state === "needs-approval" && openStartup && (
          <button type="button" className="btn" onClick={() => void openLoginItems()}>
            {openStartup}
          </button>
        )}
      </div>

      {platform === "windows" && <WhereDeskRuns host={host} helper={helper} />}

      {platform === "linux" && (
        <div className="setting-card">
          <span className="card-text">
            <b>Grid windows on Wayland</b>
            <span>
              A grid in a window of its own opens on its monitor, but on Wayland the desktop decides where on it, so it may not be
              where you left it.
            </span>
          </span>
        </div>
      )}

      <div className="setting-card">
        <span className="card-text">
          <b>Keys</b>
          <span>Desk keeps your agents’ logins and keys in {keys}.</span>
        </span>
      </div>

      <div className="setting-card">
        <span className="card-text">
          <b>Send a report</b>
          <span>{report ?? "Saves Desk’s recent logs as a zip, with passwords, keys and tokens taken out."}</span>
        </span>
        <button type="button" className="btn" disabled={!inApp} onClick={() => void sendReport()}>
          Save report…
        </button>
      </div>

      <div className="setting-card">
        <span className="card-text">
          <b>Remove Desk’s data</b>
          <span>Stops Desk Helper and, if you choose, deletes your agents, sessions and logins from this computer.</span>
        </span>
        <button type="button" className="btn btn-danger" disabled={!inApp} onClick={() => setRemoving(true)}>
          Remove Desk’s data…
        </button>
      </div>

      {removing && <RemoveData platform={platform} keys={keys} onClose={() => setRemoving(false)} />}
    </section>
  );
}

function RemoveData({ platform, keys, onClose }: { platform: Platform; keys: string; onClose: () => void }) {
  const [everything, setEverything] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await removeDeskData(everything);
      await exit(0);
    } catch (e) {
      setProblem(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      onClose={() => !busy && onClose()}
      title={(id) => (
        <header className="dialog-head">
          <span className="dialog-title">
            <h1 id={id} className="display-lg">
              Remove Desk’s data
            </h1>
            <p>Desk Helper stops and leaves {STARTUP[platform]}, so no agent or session keeps running. Desk quits when it’s done.</p>
          </span>
          <CloseButton onClose={onClose} />
        </header>
      )}
    >
      <div className="dialog-scroll">
        <label className="check-row">
          <input type="checkbox" checked={everything} onChange={(e) => setEverything(e.target.checked)} />
          <span>
            Also delete everything Desk keeps on this computer: your agents, their memories and files, sessions, settings, and the
            logins and keys saved in {keys}. This can’t be undone.
          </span>
        </label>
        {problem && (
          <p className="state-blocked" role="alert">
            {problem}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <span className="dialog-foot-note" />
        <button type="button" className="btn" data-autofocus disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
          {busy ? "Removing…" : everything ? "Delete everything and quit" : "Stop Desk Helper and quit"}
        </button>
      </div>
    </Dialog>
  );
}
