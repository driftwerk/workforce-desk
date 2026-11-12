import { relaunch } from "@tauri-apps/plugin-process";
import { useEffect, useRef, useState } from "react";
import {
  convertToWsl2,
  detectWsl,
  fixWslForwarding,
  installWsl,
  onWslSetup,
  openUrl,
  setUpInWsl,
  subscribe,
  type SetupEvent,
  type WslDetection,
} from "../platform";
import "../styles/setup.css";
import { explain, type Problem } from "../ui/problem";
import { ProblemNote } from "../ui/ProblemNote";
import { useSetup } from "./store";
import { firstPick, LOOK_AGAIN_MS, onlyChoice, optionFor, problemText, STEPS, stepsAfter, whyNotYet } from "./wsl";

const WSL_DOCS = "https://learn.microsoft.com/windows/wsl/networking";

type Stage = "finding" | "no-wsl" | "choose" | "setup";

/** Windows' first run: Desk's own agents, their memory, terminals and
 *  sessions run in the person's Linux, inside WSL. Finds WSL, has the
 *  person choose a distro, and sets Desk up there; workspaces they connect
 *  work meanwhile, so it can wait. */
export function WindowsSetup() {
  const skip = useSetup((s) => s.skip);
  const [stage, setStage] = useState<Stage>("finding");
  const [found, setFound] = useState<WslDetection | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [events, setEvents] = useState<SetupEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [installing, setInstalling] = useState(false);
  // Set up by itself once, when there's only one Linux it could use.
  const started = useRef(false);

  /** Looks for WSL; `quietly` while waiting for it, without the
   *  "Looking…" screen. */
  const find = async (quietly = false) => {
    if (!quietly) setStage("finding");
    try {
      const d = await detectWsl();
      if (quietly && d.problem) return;
      setFound(d);
      setPick(firstPick(d.distros));
      setProblem(null);
      setStage(d.problem ? "no-wsl" : "choose");
    } catch (e) {
      if (quietly) return;
      setProblem(explain(e, { what: "looking for WSL", retry: () => void find() }));
      setStage("no-wsl");
    }
  };
  useEffect(() => {
    void find();
  }, []);
  // While WSL isn't there, Desk looks again by itself: after the install,
  // the restart, or the person installing it their own way.
  useEffect(() => {
    if (stage !== "no-wsl") return;
    const look = () => void find(true);
    const every = setInterval(look, LOOK_AGAIN_MS);
    window.addEventListener("focus", look);
    return () => {
      clearInterval(every);
      window.removeEventListener("focus", look);
    };
  }, [stage]);
  useEffect(() => subscribe(onWslSetup((e) => setEvents((all) => [...all, e]))), []);

  const option = found?.distros.map(optionFor).find((o) => o.name === pick) ?? null;
  const steps = stepsAfter(events);
  const blocked = steps.reach.state === "blocked";
  const ready = steps.startup.state === "done";

  const run = async (what: string, work: () => Promise<void>, again: () => void) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(explain(e, { what, retry: again }));
    } finally {
      setBusy(false);
    }
  };

  const setUpIn = (name: string, convert: boolean) =>
    run(
      `setting Desk up in ${name}`,
      async () => {
        if (convert) await convertToWsl2(name);
        setEvents([]);
        setStage("setup");
        await setUpInWsl(name);
      },
      () => void setUpIn(name, convert),
    );
  const setUp = () => (option && pick ? setUpIn(pick, option.convert) : Promise.resolve());

  // Only one Linux Desk can use: nothing to choose, so it carries on.
  useEffect(() => {
    if (stage !== "choose" || !found || started.current) return;
    const only = onlyChoice(found.distros);
    if (!only) return;
    started.current = true;
    setPick(only);
    void setUpIn(only, false);
  }, [stage, found]);

  const fix = () =>
    run(
      "turning on WSL's localhost forwarding",
      async () => {
        if (pick) await fixWslForwarding(pick);
      },
      () => void fix(),
    );

  const install = () =>
    run(
      "installing WSL",
      async () => {
        setInstalling(true);
        await installWsl();
      },
      () => void install(),
    );
  const notYet = whyNotYet(option, busy);

  const rail: [string, boolean, boolean][] = [
    ["Find WSL", stage === "no-wsl" || stage === "finding", stage === "choose" || stage === "setup"],
    ["Choose your Linux", stage === "choose", stage === "setup"],
    ["Set up Desk inside it", stage === "setup" && !ready, ready],
  ];

  return (
    <div className="wsl-setup" role="dialog" aria-modal="true" aria-label="Set Desk up in WSL">
      <aside className="wsl-rail">
        <div className="wordmark">
          <span>desk</span>
          <span className="wordmark-dot" />
        </div>
        <h1 className="display-md">Your agents and sessions run in Linux, inside WSL</h1>
        <p className="muted small">
          Desk is a Windows app. Your local agents, their memory, terminals and Claude Code or Codex sessions run in the Linux you
          already work in, so they see your repos and tools. Workspaces you connect, like your company’s, work either way.
        </p>
        <ol className="wsl-rail-steps">
          {rail.map(([label, current, done], i) => (
            <li key={label} className={current ? "current" : done ? "done" : undefined}>
              <span className="wsl-tick">{done ? "✓" : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <button type="button" className="link small" onClick={skip}>
          Not now: use connected workspaces only
        </button>
      </aside>

      <main className="wsl-main">
        {stage === "finding" && <p className="faint">Looking for WSL…</p>}

        {stage === "no-wsl" && (
          <>
            <h2 className="display-lg">{found?.problem ? problemText(found.problem) : "Desk couldn’t ask WSL"}</h2>
            <p className="muted wsl-measure">
              WSL runs a real Linux beside Windows. Desk sets it up with one command; Windows asks for an administrator’s OK, then
              needs a restart.
            </p>
            <div className="wsl-card wsl-measure">
              <code>wsl --install -d Ubuntu</code>
              <span className="muted small">About 5 minutes, then restart when Windows asks. Desk opens by itself after the restart and carries on here.</span>
              <span className="wsl-actions">
                <button type="button" className="btn btn-signal" disabled={busy || (installing && !problem)} onClick={() => void install()}>
                  {installing && !problem ? "Installing…" : "Install WSL and Ubuntu"}
                </button>
              </span>
              <span className="faint small">
                {installing && !problem
                  ? "Windows asks for an administrator’s OK, then to restart when it’s done."
                  : "Installed it another way? Desk notices by itself."}
              </span>
            </div>
            <p className="muted small">Until then you can still connect a workspace and chat with its agents.</p>
          </>
        )}

        {stage === "choose" && found && (
          <>
            <h2 className="display-lg">Which Linux should Desk use?</h2>
            <p className="muted">
              Pick the one you do your work in. Terminals and sessions open there, and agents asked to work on this computer work
              there.
            </p>
            <div className="wsl-options" role="radiogroup" aria-label="Linux">
              {found.distros.map(optionFor).map((o) => (
                <button
                  key={o.name}
                  type="button"
                  role="radio"
                  aria-checked={pick === o.name}
                  disabled={!o.usable}
                  className={pick === o.name ? "wsl-option on" : "wsl-option"}
                  onClick={() => setPick(o.name)}
                >
                  <span className="wsl-radio" />
                  <span className="wsl-option-text">
                    <b>{o.name}</b>
                    <span className="muted small">{o.note}</span>
                  </span>
                  <span className="wsl-tag">{o.tag}</span>
                </button>
              ))}
            </div>
            <span className="wsl-actions">
              <button
                type="button"
                className="btn btn-signal"
                disabled={!!notYet || busy}
                title={notYet ?? undefined}
                onClick={() => void setUp()}
              >
                {option?.convert ? "Convert to WSL 2, then set up" : `Set up Desk in ${pick ?? "Linux"}`}
              </button>
              <span className="muted small">{notYet ?? "Desk keeps its files in your Linux home, never on C:."}</span>
            </span>
          </>
        )}

        {stage === "setup" && pick && (
          <>
            <h2 className="display-lg">{ready ? `Desk is ready in ${pick}` : `Setting up Desk in ${pick}`}</h2>
            <ol className="wsl-card wsl-steps">
              {STEPS.map(({ step, label, note }, i) => {
                const view = steps[step];
                const mark = { waiting: String(i + 1), running: "…", done: "✓", failed: "!", blocked: "!" }[view.state];
                return (
                  <li key={step} className={`wsl-step ${view.state}`}>
                    <span className="wsl-tick">{mark}</span>
                    <span className="wsl-option-text">
                      <span>{label(pick)}</span>
                      <span className="muted small">{step === "reach" && blocked ? "" : (view.note ?? note)}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
            {blocked && (
              <div className="wsl-card wsl-warn">
                <b>Windows can’t reach Desk inside {pick}</b>
                <span className="muted small">
                  Desk is running in {pick}, but WSL isn’t passing its port to Windows. Turning on localhost forwarding fixes it; WSL
                  then restarts, which closes anything running in it.
                </span>
                <code className="wsl-config">{steps.reach.note}</code>
                <span className="wsl-actions">
                  <button type="button" className="btn btn-signal" disabled={busy} onClick={() => void fix()}>
                    Fix it and restart WSL
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => openUrl(WSL_DOCS)}>
                    Show me how
                  </button>
                </span>
              </div>
            )}
            {ready && (
              <span className="wsl-actions">
                <button type="button" className="btn btn-signal" onClick={() => void relaunch()}>
                  Open Desk
                </button>
                <span className="muted small">Settings → Help → Where Desk runs shows {pick}, and lets you move later.</span>
              </span>
            )}
          </>
        )}

        {problem && (
          <div role="alert" className="wsl-measure">
            <ProblemNote problem={problem} />
          </div>
        )}
      </main>
    </div>
  );
}
