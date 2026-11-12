import { relaunch } from "@tauri-apps/plugin-process";
import { useEffect, useRef, useState } from "react";
import {
  convertToWsl2,
  createWslUser,
  detectWsl,
  fixWslForwarding,
  forgetWslResume,
  installUbuntuAlongside,
  wslUserName,
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
import { firstPick, LOOK_AGAIN_MS, START_SOON_MS, offerAlongside, onlyChoice, optionFor, problemText, STEPS, stepsAfter, whyNotYet, type DistroOption } from "./wsl";

const WSL_DOCS = "https://learn.microsoft.com/windows/wsl/networking";

type Stage = "finding" | "no-wsl" | "choose" | "setup";

/** Windows' first run: Desk's own agents, their memory, terminals and
 *  sessions run in the person's Linux, inside WSL. Finds WSL, has the
 *  person choose a distro, and sets Desk up there; workspaces they connect
 *  work meanwhile, so it can wait. */
export function WindowsSetup() {
  const skipSetup = useSetup((s) => s.skip);
  // Not now: nothing is coming that needs Desk to open after a restart.
  const skip = () => {
    void forgetWslResume().catch(() => undefined);
    skipSetup();
  };
  const [stage, setStage] = useState<Stage>("finding");
  const [found, setFound] = useState<WslDetection | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [events, setEvents] = useState<SetupEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [installing, setInstalling] = useState(false);
  // Set up by itself once, when there's only one Linux it could use.
  const started = useRef(false);
  // The only Linux, about to be set up: a moment to cancel first.
  const [soon, setSoon] = useState<string | null>(null);
  const stageNow = useRef(stage);
  stageNow.current = stage;

  /** Looks for WSL; `quietly` while waiting for it, without the
   *  "Looking…" screen. A quiet look that comes back after the stage moved
   *  on (or the wait ended) is ignored. */
  const find = async (quietly = false, gone: () => boolean = () => false) => {
    if (!quietly) setStage("finding");
    try {
      const d = await detectWsl();
      if (quietly && (gone() || stageNow.current !== "no-wsl")) return;
      if (quietly && d.problem) return;
      setFound(d);
      setPick(firstPick(d.distros));
      setProblem(null);
      setStage(d.problem ? "no-wsl" : "choose");
    } catch (e) {
      if (quietly || gone()) return;
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
    let cancelled = false;
    const look = () => void find(true, () => cancelled);
    const every = setInterval(look, LOOK_AGAIN_MS);
    window.addEventListener("focus", look);
    return () => {
      cancelled = true;
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

  /** What Desk is doing before it sets up, said while it runs. */
  const [fixing, setFixing] = useState<string | null>(null);
  const setUpIn = (name: string, fix: DistroOption["fix"]) =>
    run(
      `setting Desk up in ${name}`,
      async () => {
        try {
          if (fix === "convert") {
            setFixing(`Moving ${name} to WSL 2… This takes a few minutes; your files stay.`);
            await convertToWsl2(name);
          }
          if (fix === "user") {
            setFixing(`Making you a user in ${name}…`);
            await createWslUser(name);
          }
        } finally {
          setFixing(null);
        }
        setEvents([]);
        setStage("setup");
        await setUpInWsl(name);
      },
      () => void setUpIn(name, fix),
    );
  /** A fix Desk makes in the person's Linux, said in full (the user it
   *  makes, and what stops) before their yes. */
  const [confirming, setConfirming] = useState<{ fix: "convert" | "user" | "alongside"; distro: string; user: string } | null>(null);
  const ask = async (fix: "convert" | "user" | "alongside", distro: string) => {
    const user = fix === "convert" ? "" : await wslUserName().catch(() => "");
    setConfirming({ fix, distro, user });
  };
  const setUp = () => {
    if (!option || !pick) return Promise.resolve();
    if (option.fix) return ask(option.fix, pick);
    return setUpIn(pick, null);
  };
  /** "Install Ubuntu alongside": a current Ubuntu beside a Linux too old
   *  for Desk (which stays as it is), with a user of the person's, then
   *  Desk is set up there. */
  const alongside = () =>
    run(
      "installing Ubuntu alongside",
      async () => {
        let name: string;
        try {
          setFixing("Installing Ubuntu 24.04… About 5 minutes. Your Linux stays as it is.");
          name = await installUbuntuAlongside();
        } finally {
          setFixing(null);
        }
        setPick(name);
        setEvents([]);
        setStage("setup");
        await setUpInWsl(name);
      },
      () => void alongside(),
    );

  // Only one Linux Desk can use: nothing to choose, so it carries on,
  // after a moment in which the person can still say no.
  useEffect(() => {
    if (stage !== "choose" || !found || started.current) return;
    const only = onlyChoice(found.distros);
    if (!only) return;
    started.current = true;
    setPick(only);
    setSoon(only);
  }, [stage, found]);
  useEffect(() => {
    if (!soon) return;
    const go = setTimeout(() => {
      setSoon(null);
      void setUpIn(soon, null);
    }, START_SOON_MS);
    return () => clearTimeout(go);
  }, [soon]);

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

        {stage === "choose" && soon && (
          <>
            <h2 className="display-lg">Setting up Desk in {soon}…</h2>
            <p className="muted wsl-measure">
              It’s the only Linux Desk can use here, so Desk sets its helper, agents and memory up there now.
            </p>
            <span className="wsl-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setSoon(null)}>
                Cancel
              </button>
            </span>
          </>
        )}

        {stage === "choose" && found && !soon && (
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
            {!offerAlongside(found.distros) && !confirming && (
              <span className="wsl-actions">
                <button
                  type="button"
                  className="btn btn-signal"
                  disabled={!!notYet || busy}
                  title={notYet ?? undefined}
                  onClick={() => void setUp()}
                >
                  {option?.fix === "convert"
                    ? "Convert to WSL 2, then set up"
                    : option?.fix === "user"
                      ? "Create a user, then set up"
                      : `Set up Desk in ${pick ?? "Linux"}`}
                </button>
                <span className="muted small">{fixing ?? notYet ?? "Desk keeps its files in your Linux home, never on C:."}</span>
              </span>
            )}
            {offerAlongside(found.distros) && !confirming && (
              <div className="wsl-card wsl-measure" aria-label="Install Ubuntu alongside">
                <b>Install Ubuntu alongside</b>
                <span className="muted small">
                  Desk installs Ubuntu 24.04 beside your Linux, which stays as it is, makes you a user there and sets itself up in it.
                  About 5 minutes.
                </span>
                <span className="wsl-actions">
                  <button type="button" className="btn btn-signal" disabled={busy || !!confirming} onClick={() => void ask("alongside", "Ubuntu-24.04")}>
                    {fixing && busy ? "Installing…" : "Install Ubuntu alongside"}
                  </button>
                  {fixing && <span className="muted small">{fixing}</span>}
                </span>
              </div>
            )}
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

        {stage === "choose" && confirming && (
          <div className="wsl-card wsl-measure" role="group" aria-label="Before Desk changes your Linux">
            <span>
              {confirming.fix === "convert"
                ? `Desk moves ${confirming.distro} to WSL 2. It takes a few minutes, and anything running in ${confirming.distro} stops; your files stay.`
                : confirming.fix === "user"
                  ? `Desk makes the user ${confirming.user || "for you"} in ${confirming.distro}, who can use sudo without a password (set one any time with passwd), and makes it the default. ${confirming.distro} then restarts: anything running in it stops. Your files stay.`
                  : `Desk installs Ubuntu 24.04 beside your Linux, which stays as it is, makes you the user ${confirming.user || "for you"} there (sudo without a password; set one any time with passwd), and sets itself up in it. About 5 minutes.`}
            </span>
            <span className="wsl-actions">
              <button
                type="button"
                className="btn btn-signal"
                disabled={busy}
                onClick={() => {
                  const c = confirming;
                  setConfirming(null);
                  if (c.fix === "alongside") void alongside();
                  else void setUpIn(c.distro, c.fix);
                }}
              >
                {confirming.fix === "convert"
                  ? `Move ${confirming.distro} to WSL 2`
                  : confirming.fix === "user"
                    ? `Create ${confirming.user || "the user"} and restart ${confirming.distro}`
                    : "Install Ubuntu 24.04"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </span>
          </div>
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
