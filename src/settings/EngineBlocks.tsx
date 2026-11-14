import { useCallback, useEffect, useRef, useState } from "react";
import { explain } from "../ui/problem";
import { ProblemNote } from "../ui/ProblemNote";
import { hasAccounts } from "../engines/accounts";
import { defaultCaps, installedText, runsText, signInText } from "../engines/engines";
import { CODEX_LOGIN, useCodexSignIn, useDevinSignIn } from "../engines/signIn";
import { LOCAL, type MachineId } from "../hub/machines";
import { hubOf, useHubOf } from "../hub/store";
import type { EngineInfo } from "../hub/types";
import { native as realNative, type MachineNative } from "../machines/native";
import { openTerminalOn } from "../machines/watch";
import { thisComputerLower } from "../machines/words";
import { useHost } from "../shell/host";
import { installCli, onInstallProgress, subscribe, type CliName } from "../platform";
import { Accounts, CodeField, useHasAccount } from "./Accounts";

export type SignedInEngine = "claude" | "codex" | "devin";

/** Copies `text`, saying so on the button for a moment. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** How long an engine list read waits for its hub. */
export const ENGINES_WITHIN_MS = 15_000;
/** How long Desk waits for a machine to connect before saying so. */
export const CONNECT_WITHIN_MS = 60_000;

/** `p`, or a plain failure once `ms` pass without an answer. */
export const within = <T,>(p: Promise<T>, ms: number, why: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(why)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

/** Whether this computer's own Codex is signed in to ChatGPT. */
const codexSignedInHere = async (): Promise<boolean> => {
  const engines = await hubOf(LOCAL)
    ?.engines()
    .catch(() => null);
  return engines?.find((e) => e.engine === "codex")?.signIn.state === "in";
};

/** The engines on `machine` (this computer when none), each where it
 *  stands, and its sign-in: Claude's accounts, Codex's ChatGPT, Devin's
 *  own. One
 *  component wherever an engine signs in: Settings → Engines with any
 *  computer chosen, a machine's page, and adding a machine. */
export function EngineBlocks({
  machine = LOCAL,
  name,
  native = realNative,
  onSignedIn,
  only,
}: {
  machine?: MachineId;
  /** The machine's name. */
  name?: string;
  native?: MachineNative;
  /** An engine is signed in there: said once for each. */
  onSignedIn?: (engine: SignedInEngine) => void;
  /** Only these engines (adding a machine shows Claude Code and Codex). */
  only?: readonly string[];
}) {
  const hub = useHubOf(machine);
  const platform = useHost((h) => h.platform);
  const where = machine === LOCAL ? thisComputerLower(platform) : (name ?? machine);
  const asked = machine === LOCAL ? "Desk" : where;
  // The list stays through a reload and a reconnect: "Reading…" only
  // before there is one.
  const [engines, setEngines] = useState<EngineInfo[] | null | { failed: string }>(null);
  /** Reads the list; `now`: the hub reads each engine again first (after an
   *  install or a sign-in), else it says what it last read. */
  const reload = useCallback(async (now = false) => {
    if (!hub) return;
    try {
      const list = await within(now ? hub.enginesNow() : hub.engines(), ENGINES_WITHIN_MS, `${asked} didn’t answer within ${ENGINES_WITHIN_MS / 1000} s.`);
      setEngines(list);
    } catch (e) {
      setEngines((now) => (Array.isArray(now) ? now : { failed: e instanceof Error ? e.message : String(e) }));
    }
  }, [hub, asked]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // Waiting for the machine to connect: said once it takes a minute.
  const [slowConnect, setSlowConnect] = useState(false);
  useEffect(() => {
    setSlowConnect(false);
    if (hub) return;
    const t = setTimeout(() => setSlowConnect(true), CONNECT_WITHIN_MS);
    return () => clearTimeout(t);
  }, [hub]);
  // Codex signs in to ChatGPT through its device page, run by its engine's
  // hub: a machine's, or this computer's own `codex login`.
  const codex = useCodexSignIn(machine, where, native, () => void reload(true));
  // Devin signs in by its own page, also run by its engine's hub.
  const devin = useDevinSignIn(machine, where, native, () => void reload(true));

  // Each engine signed in there, said once.
  const told = useRef(new Set<SignedInEngine>());
  const tell = useRef(onSignedIn);
  tell.current = onSignedIn;
  const signed = (e: SignedInEngine) => {
    if (told.current.has(e)) return;
    told.current.add(e);
    tell.current?.(e);
  };
  const list = Array.isArray(engines) ? engines.filter((e) => !only || only.includes(e.engine)) : [];
  const claudeIn = list.some((e) => e.engine === "claude" && e.signIn.state === "in");
  const codexIn = list.some((e) => e.engine === "codex" && e.signIn.state === "in") || codex.run.at === "done";
  const devinIn = list.some((e) => e.engine === "devin" && e.signIn.state === "in") || devin.run.at === "done";
  const accountsIn = useHasAccount(machine);
  useEffect(() => {
    if (claudeIn || accountsIn) signed("claude");
    if (codexIn) signed("codex");
    if (devinIn) signed("devin");
  });

  if (!hub && !Array.isArray(engines)) {
    if (machine === LOCAL) return <p className="faint small">Desk isn’t ready yet.</p>;
    return (
      <p className={`small ${slowConnect ? "state-blocked" : "faint"}`}>
        {slowConnect ? `${where} hasn’t connected in a minute.` : `Waiting for ${where} to connect…`}{" "}
        {slowConnect && (
          <button type="button" className="btn btn-sm" onClick={() => void native.reconnect(machine).catch(() => undefined)}>
            Try again
          </button>
        )}
      </p>
    );
  }
  if (engines && !Array.isArray(engines))
    return (
      <p className="state-blocked small">
        Couldn’t ask {asked} about its engines just now: {engines.failed}{" "}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setEngines(null);
            void reload();
          }}
        >
          Try again
        </button>
      </p>
    );
  if (engines === null) return <p className="faint small">Reading… Desk gives up after {ENGINES_WITHIN_MS / 1000} s and says why.</p>;
  return (
    <ul className="engine-list" aria-label={`Engines on ${where}`}>
      {!hub && <li className="small muted">{where} is offline for the moment: Desk carries on here once it’s back.</li>}
      {list.map((e) => (
        <li key={e.engine} className="engine-row" aria-label={e.title}>
          <span className="engine-head">
            <b>{e.title}</b>
            <span className="muted small">{installedText(e)}</span>
            {e.engine === "codex" && e.installed && e.signIn.state !== "in" && codex.run.at === "idle" && (
              <button type="button" className="btn btn-sm engine-head-action" onClick={() => void codex.begin()}>
                Sign in…
              </button>
            )}
            {e.engine === "devin" && e.installed && e.signIn.state !== "in" && devin.run.at === "idle" && (
              <button type="button" className="btn btn-sm engine-head-action" onClick={() => void devin.begin()}>
                Sign in…
              </button>
            )}
            {e.installed === false && installsOn(e.engine, machine) && <InstallEngine engine={e} machine={machine} where={where} native={native} onInstalled={() => void reload(true)} />}
          </span>
          {e.installed && (
            <span className="small">
              {codex.run.at === "done" && e.engine === "codex" ? "Signed in" : devin.run.at === "done" && e.engine === "devin" && e.signIn.state !== "in" ? signInText({ state: "in", via: "vendor", who: null, plan: null }, e.title) : signInText(e.signIn, e.engine === "devin" ? e.title : undefined)}
              {e.engine === "codex" && e.signIn.state !== "in" && <span className="muted"> · optional, for Codex sessions</span>}
            </span>
          )}
          <span className="faint small">{runsText(e)}</span>
          {defaultCaps(e)?.notes?.map((n) => (
            <span key={n} className="faint small">
              {n}
            </span>
          ))}
          {e.installed && e.engine === "claude" && hasAccounts(defaultCaps(e)) && (
            <Accounts
              engine={e}
              machine={machine}
              name={name}
              native={native}
              onShared={() => {
                void reload();
                // ChatGPT comes along: never by copying this computer's
                // sign-in, which two computers can't share, but by the
                // machine's own.
                if (!codexIn && codex.run.at === "idle")
                  void codexSignedInHere().then((yes) => {
                    if (yes) void codex.begin();
                  });
              }}
            />
          )}
          {e.installed && e.engine === "codex" && codex.run.at !== "idle" && <CodexSigningIn codex={codex} machine={machine} where={where} />}
          {e.installed && e.engine === "devin" && devin.run.at !== "idle" && <DevinSigningIn devin={devin} />}
        </li>
      ))}
    </ul>
  );
}

/** The engines Desk can install, by their installers' names. */
const INSTALLS: Partial<Record<string, CliName>> = { claude: "claude", codex: "chatgpt", devin: "devin" };
/** What Desk installs on a machine, over its connection (both at once). */
const MACHINE_INSTALLS = new Set(["claude", "codex"]);

/** Whether Desk can install `engine` on `machine` from its row. */
export const installsOn = (engine: string, machine: MachineId): boolean =>
  !!INSTALLS[engine] && (machine === LOCAL || MACHINE_INSTALLS.has(engine));

/** "Install" on an engine that isn't there: on this computer, its own
 *  installer, run by Desk (as signing in to a plan does); on a machine,
 *  Desk installs Claude Code and Codex there over its connection, as adding
 *  it did, and its Desk starts again to find them. Then the list is read
 *  again, so the row says it's installed. */
export function InstallEngine({
  engine,
  machine,
  where,
  native,
  onInstalled,
}: {
  engine: EngineInfo;
  machine: MachineId;
  where: string;
  native: MachineNative;
  onInstalled: () => void;
}) {
  const plan = INSTALLS[engine.engine]!;
  const [state, setState] = useState<{ at: "idle" } | { at: "running"; line: string } | { at: "failed"; why: string; command?: string; details?: string }>({
    at: "idle",
  });
  const done = useRef(onInstalled);
  done.current = onInstalled;
  useEffect(() => {
    if (machine === LOCAL)
      return subscribe(
        onInstallProgress((p, next) => {
          if (p !== plan) return;
          if (next.state === "running") setState({ at: "running", line: next.line });
          else if (next.state === "done") {
            setState({ at: "idle" });
            done.current();
          } else setState({ at: "failed", why: next.message, command: next.command, details: next.details });
        }),
      );
    return native.setup((e) => {
      if (e.machine !== machine || e.step !== "engines") return;
      if (e.state === "running") setState({ at: "running", line: "" });
      else if (e.state === "done") {
        setState({ at: "idle" });
        done.current();
      } else setState({ at: "failed", why: e.message ?? `Desk couldn’t install them on ${where}.` });
    });
  }, [machine, plan, native, where]);
  const install = () => {
    setState({ at: "running", line: "" });
    const started = machine === LOCAL ? installCli(plan) : native.retryEngines(machine);
    started.catch((e: unknown) => setState({ at: "failed", why: e instanceof Error ? e.message : String(e) }));
  };
  if (state.at === "running")
    return (
      <span className="engine-install small" role="status">
        <span className="muted">
          Installing {machine === LOCAL ? engine.title : `Claude Code and Codex on ${where}`}…{state.line ? ` ${state.line}` : ""}
        </span>
      </span>
    );
  return (
    <span className="engine-install">
      {state.at === "failed" && (
        <span className="small state-blocked" role="alert">
          {state.why}
          {state.command && (
            <>
              {" "}
              <CopyButton text={state.command} label="Copy command" />
            </>
          )}
          {state.details && (
            <details className="problem-details">
              <summary className="small faint">Details</summary>
              <pre className="problem-raw mono small">{state.details}</pre>
            </details>
          )}
        </span>
      )}
      <button type="button" className="btn btn-sm btn-signal engine-head-action" onClick={install}>
        {state.at === "failed" ? "Try again" : `Install ${engine.title}`}
      </button>
    </span>
  );
}

/** Devin's sign-in under way, as Codex's is drawn: its page opening, open
 *  (with the field for the token it gives, where it gives one), done, or
 *  failed with why. */
export function DevinSigningIn({ devin }: { devin: ReturnType<typeof useDevinSignIn> }) {
  const r = devin.run;
  if (r.at === "idle") return null;
  return (
    <div className="account-add account-add-solo" role="group" aria-label="Signing in to Devin" aria-live="polite">
      <b className="small">Signing in to Devin</b>
      {r.at === "opening" && (
        <>
          <p className="small">Opening Devin’s sign-in page…</p>
          <span className="faint small">If the page hasn’t opened in 30 s, Desk stops and says why.</span>
        </>
      )}
      {r.at === "page" &&
        (r.paste ? (
          <>
            {r.why ? <p className="small state-blocked">{r.why}</p> : <p className="small">Sign in on the page that opened, then paste the token it shows here.</p>}
            <CodeField onSend={(token) => void devin.sendToken(token)} focus secret label="Token from Devin’s sign-in page" placeholder="Token from the page" />
            <span>
              <button type="button" className="btn btn-ghost" onClick={() => devin.openPage(r.url)}>
                Open the sign-in page again
              </button>
            </span>
            <span className="faint small">Desk passes the token straight to Devin, and keeps it nowhere. It waits up to 10 minutes, then stops the sign‑in.</span>
          </>
        ) : (
          <>
            <p className="small">Finish signing in in your browser.</p>
            <span className="account-links">
              <button type="button" className="btn btn-ghost" onClick={() => devin.openPage(r.url)}>
                Open the sign-in page again
              </button>
              <button type="button" className="link small" onClick={devin.withToken}>
                Paste a token instead
              </button>
            </span>
            <span className="faint small">Desk carries on by itself once you’ve signed in. It waits up to 10 minutes, then stops the sign‑in.</span>
          </>
        ))}
      {r.at === "done" && (
        <p className="small">
          <span className="state-done">Devin is signed in.</span>
        </p>
      )}
      {r.at === "failed" && (
        <div role="alert">
          <ProblemNote problem={explain(new Error(r.why), { what: "signing in to Devin", retry: devin.again })} />
        </div>
      )}
      <span className="account-actions">
        {r.at === "done" ? (
          <button type="button" className="btn" onClick={devin.reset}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" onClick={r.at === "failed" ? devin.reset : devin.cancel}>
              Cancel
            </button>
            {r.at === "failed" && (
              <button type="button" className="btn" onClick={devin.again}>
                Try again
              </button>
            )}
          </>
        )}
      </span>
    </div>
  );
}

/** Codex's device sign-in under way, as the SignIn board draws it. */
export function CodexSigningIn({ codex, machine, where }: { codex: ReturnType<typeof useCodexSignIn>; machine: MachineId; where: string }) {
  const r = codex.run;
  if (r.at === "idle") return null;
  return (
    <>
      <div className="account-add account-add-solo" role="group" aria-label="Signing in to ChatGPT" aria-live="polite">
        <b className="small">Signing in to ChatGPT</b>
        {r.at === "opening" && (
          <>
            <p className="small">Opening ChatGPT’s sign-in page…</p>
            <span className="faint small">If the page hasn’t opened in 30 s, Desk stops and says why.</span>
          </>
        )}
        {r.at === "device" && (
          <>
            <p className="small">Sign in on the page that opened, and type this code there:</p>
            <span className="signin-code-row">
              <code className="signin-code">{r.code}</code>
              <CopyButton text={r.code} />
            </span>
            <span>
              <button type="button" className="btn btn-ghost" onClick={() => codex.openPage(r.url)}>
                Open the sign-in page again
              </button>
            </span>
            <span className="faint small">The code works for 15 minutes. Desk carries on by itself once you’ve typed it, then stops the sign-in when it runs out.</span>
          </>
        )}
        {r.at === "done" && (
          <p className="small">
            <span className="state-done">ChatGPT is signed in.</span>
          </p>
        )}
        {r.at === "failed" && (
          <div role="alert">
            <ProblemNote problem={explain(new Error(r.why), { what: "signing in to ChatGPT", retry: () => void codex.begin() })} />
          </div>
        )}
        {r.at === "terminal" && (
          <>
            <span className="small muted">Desk on {where} is too old to sign ChatGPT in itself. Sign in in a terminal there:</span>
            <span className="machine-line">
              <code className="mono small">{CODEX_LOGIN}</code>
              {machine !== LOCAL && (
                <button type="button" className="btn btn-sm" onClick={() => openTerminalOn(machine)}>
                  Open a terminal
                </button>
              )}
            </span>
          </>
        )}
        <span className="account-actions">
          {r.at === "done" ? (
            <button type="button" className="btn" onClick={codex.reset}>
              Done
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-ghost" onClick={r.at === "failed" || r.at === "terminal" ? codex.reset : codex.cancel}>
                Cancel
              </button>
              {r.at === "failed" && (
                <button type="button" className="btn" onClick={() => void codex.begin()}>
                  Try again
                </button>
              )}
            </>
          )}
        </span>
      </div>
    </>
  );
}
