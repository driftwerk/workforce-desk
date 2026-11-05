import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HubError, transportCall, type DeskHub } from "../hub/client";
import type { DeskTransport } from "../hub/transport";
import type { AccountSignIn, AccountsInfo, EngineInfo, EngineSignIn } from "../hub/types";
import { openUrl } from "../platform";
import { plainError } from "../ui/plainError";
import { useHubOf, type MachineId } from "./engines";
import { native as realNative, type MachineNative } from "./native";
import { openTerminalOn } from "./watch";

/** Codex's sign-in for a computer with no browser of its own, for a hub
 *  too old to run it itself. */
export const CODEX_LOGIN = "codex login --device-auth";

/** How often a sign-in under way is read again. */
export const SIGN_IN_POLL_MS = 1000;

export type MachineEngine = "claude" | "codex";

/** Where one engine on a machine stands: null until its hub has said. */
export type SignedIn = { in: true; who: string | null } | { in: false } | null;

/** Who each engine on the machine is signed in as, from its own hub: Claude
 *  through a Desk account there (the default one) or its CLI's own
 *  sign-in, ChatGPT through Codex's own. */
export const signedInOf = (accounts: AccountsInfo | null, engines: EngineInfo[] | null): Record<MachineEngine, SignedIn> => {
  const engine = (e: MachineEngine) => engines?.find((x) => x.engine === e) ?? null;
  const cli = (e: MachineEngine): SignedIn => {
    const info = engine(e);
    if (!info) return null;
    return info.signIn.state === "in" ? { in: true, who: info.signIn.who } : info.signIn.state === "out" ? { in: false } : null;
  };
  const claudeCli = cli("claude");
  const account = accounts?.accounts.find((a) => a.engine === "claude" && a.isDefault && a.signedIn) ?? null;
  const claude: SignedIn = account ? { in: true, who: claudeCli?.in ? claudeCli.who : null } : claudeCli ?? (accounts ? { in: false } : null);
  return { claude, codex: cli("codex") };
};

/** The machine's sign-ins as its hub says them now, read again on `reload`. */
export function useMachineSignIns(hub: DeskHub | null) {
  const [said, setSaid] = useState<Record<MachineEngine, SignedIn>>({ claude: null, codex: null });
  const [accounts, setAccounts] = useState<AccountsInfo | null>(null);
  const reload = useCallback(async () => {
    if (!hub) return;
    const quietly = async <T,>(f: () => Promise<T>): Promise<T | null> => {
      try {
        return await f();
      } catch {
        return null;
      }
    };
    const [a, e] = await Promise.all([quietly(() => hub.accounts()), quietly(() => hub.engines())]);
    setAccounts(a);
    setSaid((now) => {
      const next = signedInOf(a, e);
      // What a sign-in just finished stays said until the hub says it too.
      return { claude: next.claude ?? now.claude, codex: next.codex ?? now.codex };
    });
  }, [hub]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const signedIn = (engine: MachineEngine, who: string | null = null) => setSaid((now) => ({ ...now, [engine]: { in: true, who } }));
  return { said, accounts, reload, signedIn };
}

/** "Claude", else the first of "Claude 2", "Claude 3"… no account or sign-in
 *  under way there is called. */
export const freeName = (accounts: AccountsInfo | null): string => {
  const taken = new Set([...(accounts?.accounts ?? []).map((a) => a.name.toLowerCase()), ...(accounts?.signIns ?? []).map((s) => s.name.toLowerCase())]);
  for (let n = 1; ; n++) {
    const name = n === 1 ? "Claude" : `Claude ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
};

const over = (s: { state: string }) => s.state === "done" || s.state === "failed";

type ClaudeRun =
  | { at: "idle" }
  | { at: "starting" }
  /** Under way: in the browser by itself (`direct`), or with a code to paste. */
  | { at: "running"; signIn: AccountSignIn; direct: boolean; codeAsked: boolean; why: string | null }
  | { at: "done" }
  | { at: "failed"; why: string };

/** Signing Claude in on the machine as on this computer: the machine's hub
 *  runs Claude Code's sign-in, its page opens here, and the page comes back
 *  to the machine through a forward of its one port for as long as the
 *  sign-in runs. When it can't (an older hub, the port taken here), the
 *  page with a code opens instead, and the code is pasted here. */
function useClaudeSignIn(machine: MachineId, hub: DeskHub | null, native: MachineNative, onDone: () => void) {
  const [run, setRun] = useState<ClaudeRun>({ at: "idle" });
  const opened = useRef<{ id: string; direct: boolean; code: boolean } | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const stopForward = useCallback(() => void native.signInForwardStop(machine).catch(() => undefined), [native, machine]);

  // What the page shows next, from where the sign-in is.
  const follow = useCallback(
    (s: AccountSignIn) => {
      if (!live.current) return;
      if (s.state === "done") {
        stopForward();
        setRun({ at: "done" });
        done.current();
        return;
      }
      if (s.state === "failed") {
        stopForward();
        setRun({ at: "failed", why: s.why });
        return;
      }
      const seen = opened.current?.id === s.id ? opened.current : (opened.current = { id: s.id, direct: false, code: false });
      setRun((now) => ({
        at: "running",
        signIn: s,
        direct: now.at === "running" && now.signIn.id === s.id ? now.direct : false,
        codeAsked: now.at === "running" && now.signIn.id === s.id ? now.codeAsked : false,
        why: now.at === "running" && now.signIn.id === s.id ? now.why : null,
      }));
      if (s.direct && !seen.direct) {
        seen.direct = true;
        native
          .signInForward(machine, s.id)
          .then((url) => {
            if (!live.current) return;
            openUrl(url);
            setRun((now) => (now.at === "running" ? { ...now, direct: true } : now));
          })
          .catch((e: unknown) => {
            if (!live.current) return;
            // The page with a code still works.
            const url = s.state === "open" || s.state === "code" ? s.url : null;
            if (url && !seen.code) {
              seen.code = true;
              openUrl(url);
            }
            setRun((now) => (now.at === "running" ? { ...now, codeAsked: true, why: plainError(e) } : now));
          });
      } else if (!s.direct && s.state === "code" && s.url && !seen.code && !seen.direct) {
        // A hub that can't give the page that comes back: the page with a code.
        seen.code = true;
        openUrl(s.url);
        setRun((now) => (now.at === "running" ? { ...now, codeAsked: true } : now));
      }
    },
    [machine, native, stopForward],
  );

  const id = run.at === "running" ? run.signIn.id : null;
  useEffect(() => {
    if (!hub || !id) return;
    const t = setInterval(() => {
      void hub
        .accounts()
        .then((a) => {
          const now = a?.signIns.find((s) => s.id === id);
          if (now) follow(now);
          else if (a?.accounts.some((x) => x.engine === "claude" && x.isDefault)) follow({ id, engine: "claude", name: "", state: "done", account: "" });
          else follow({ id, engine: "claude", name: "", state: "failed", why: "The sign-in ended on the machine before it finished. Start it again." });
        })
        .catch(() => undefined);
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(t);
  }, [hub, id, follow]);

  const begin = async () => {
    if (!hub) return;
    setRun({ at: "starting" });
    opened.current = null;
    try {
      const accounts = await hub.accounts();
      // One already under way there (begun before the card closed) goes on.
      const pending = accounts?.signIns.find((s) => s.engine === "claude" && !over(s));
      if (pending) return follow(pending);
      const added = await hub.addAccount({ engine: "claude", name: freeName(accounts), makeDefault: true, remote: true });
      if (added.kind === "account") {
        setRun({ at: "done" });
        done.current();
      } else follow(added.signIn);
    } catch (e) {
      if (live.current) setRun({ at: "failed", why: plainError(e) });
    }
  };

  const cancel = () => {
    if (run.at === "running") void hub?.cancelSignIn(run.signIn.id).catch(() => undefined);
    stopForward();
    setRun({ at: "idle" });
  };

  const sendCode = async (code: string) => {
    if (!hub || run.at !== "running") return;
    try {
      follow(await hub.signInCode(run.signIn.id, code.trim()));
    } catch (e) {
      setRun((now) => (now.at === "running" ? { ...now, why: plainError(e) } : now));
    }
  };

  /** "Use a code instead": the page with a code, and the field for it. */
  const withCode = () => {
    if (run.at !== "running") return;
    const url = run.signIn.state === "open" || run.signIn.state === "code" ? run.signIn.url : null;
    if (url) openUrl(url);
    setRun({ ...run, codeAsked: true });
  };

  // Ended with the card: a sign-in under way goes on there, and is picked up
  // again by the next Sign in; its forward doesn't outlive the page.
  useEffect(() => () => void native.signInForwardStop(machine).catch(() => undefined), [native, machine]);

  return { run, begin, cancel, sendCode, withCode, busy: run.at === "starting" || run.at === "running" };
}

/** Codex's device sign-in on a machine: routes of a machine's hub alone
 *  (this computer signs its own Codex in itself), through its broker. */
export const codexSignIns = (t: DeskTransport) => ({
  start: (): Promise<EngineSignIn> => transportCall(t, "POST", "/api/desk/engines/sign-ins", { engine: "codex" }),
  read: (id: string): Promise<EngineSignIn> => transportCall(t, "GET", `/api/desk/engines/sign-ins/${encodeURIComponent(id)}`),
  cancel: (id: string): Promise<void> => transportCall(t, "DELETE", `/api/desk/engines/sign-ins/${encodeURIComponent(id)}`),
});

type CodexRun =
  | { at: "idle" }
  | { at: "starting" }
  | { at: "device"; signIn: EngineSignIn & { state: "device" } }
  | { at: "waiting"; id: string }
  | { at: "done" }
  | { at: "failed"; why: string }
  /** A hub too old to run Codex's sign-in itself: a terminal there. */
  | { at: "terminal" };

/** Signing ChatGPT in for Codex on the machine: Codex's device sign-in,
 *  run by the machine's hub, its page opened here and its code shown to
 *  type there, read again until it's done. */
function useCodexSignIn(machine: MachineId, hub: DeskHub | null, native: MachineNative, onDone: () => void) {
  const [run, setRun] = useState<CodexRun>({ at: "idle" });
  const routes = useMemo(() => codexSignIns(native.transport(machine)), [native, machine]);
  const opened = useRef<string | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const follow = useCallback((s: EngineSignIn) => {
    if (!live.current) return;
    switch (s.state) {
      case "starting":
        return setRun({ at: "waiting", id: s.id });
      case "device":
        if (opened.current !== s.id) {
          opened.current = s.id;
          openUrl(s.url);
        }
        return setRun({ at: "device", signIn: s });
      case "done":
        setRun({ at: "done" });
        return done.current();
      case "failed":
        return setRun({ at: "failed", why: s.why });
    }
  }, []);

  const id = run.at === "device" ? run.signIn.id : run.at === "waiting" ? run.id : null;
  useEffect(() => {
    if (!hub || !id) return;
    const t = setInterval(() => {
      void routes
        .read(id)
        .then(follow)
        .catch((e: unknown) => {
          if (e instanceof HubError && e.status === 404) follow({ id, engine: "codex", state: "failed", why: "The sign-in ended on the machine before it finished. Start it again." });
        });
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(t);
  }, [hub, id, follow, routes]);

  const begin = async () => {
    if (!hub) return;
    setRun({ at: "starting" });
    try {
      follow(await routes.start());
    } catch (e) {
      if (!live.current) return;
      if (e instanceof HubError && (e.status === 404 || e.status === 405)) setRun({ at: "terminal" });
      else setRun({ at: "failed", why: plainError(e) });
    }
  };

  const cancel = () => {
    if (id) void routes.cancel(id).catch(() => undefined);
    setRun({ at: "idle" });
  };

  return { run, begin, cancel, busy: run.at === "starting" || run.at === "device" || run.at === "waiting" };
}

/** Copies `text`, saying so on the button for a moment. */
function CopyButton({ text }: { text: string }) {
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
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** The code field: a group, not a form, as it sits inside the Add card's. */
function CodeField({ onSend }: { onSend: (code: string) => void }) {
  const [code, setCode] = useState("");
  const send = () => {
    if (!code.trim()) return;
    onSend(code);
    setCode("");
  };
  return (
    <span className="field-row" role="group" aria-label="Sign-in code">
      <input
        className="field-text mono"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            send();
          }
        }}
        placeholder="Code from the page"
        aria-label="Code from the sign-in page"
        autoComplete="off"
        spellCheck={false}
      />
      <button type="button" className="btn btn-sm" disabled={!code.trim()} onClick={send}>
        Send
      </button>
    </span>
  );
}

const stateText = (s: SignedIn): string => (s === null ? "Checking…" : s.in ? (s.who ? `Signed in as ${s.who}` : "Signed in") : "Not signed in");

/** One engine's line: where it stands, and its sign-in. */
function EngineLine({ title, signedIn, children }: { title: string; signedIn: SignedIn; children?: React.ReactNode }) {
  return (
    <div className="machine-signin-row" role="group" aria-label={title}>
      <b className="machine-signin-name">{title}</b>
      <span className={`small ${signedIn?.in ? "" : "muted"}`}>{stateText(signedIn)}</span>
      {children}
    </div>
  );
}

/** "Sign in on devbox": Claude and ChatGPT on the machine, each where it
 *  stands, with its Sign in. Every sign-in runs on the machine and is kept
 *  there; this computer opens its page. Shown in the Add card and on each
 *  machine's row in Settings → Machines, so closing one never strands a
 *  sign-in. `onBusy` says while one is under way or failed unread. */
export function SignInOn({
  machine,
  name,
  onSignedIn,
  onBusy,
  native = realNative,
  boxed = true,
}: {
  machine: MachineId;
  name: string;
  onSignedIn?: (engine: MachineEngine) => void;
  onBusy?: (busy: boolean) => void;
  native?: MachineNative;
  /** In a box of its own with a heading (the Add card), or bare (a row). */
  boxed?: boolean;
}) {
  const hub = useHubOf(machine);
  const { said, reload, signedIn } = useMachineSignIns(hub);
  const told = useRef(onSignedIn);
  told.current = onSignedIn;
  const claude = useClaudeSignIn(machine, hub, native, () => {
    signedIn("claude");
    told.current?.("claude");
    void reload();
  });
  const codex = useCodexSignIn(machine, hub, native, () => {
    signedIn("codex");
    told.current?.("codex");
    void reload();
  });

  // Signed in before the card opened: said as such.
  useEffect(() => {
    if (said.claude?.in) told.current?.("claude");
    if (said.codex?.in) told.current?.("codex");
  }, [said.claude?.in, said.codex?.in]);

  const busy = claude.busy || codex.busy || claude.run.at === "failed" || codex.run.at === "failed";
  useEffect(() => onBusy?.(busy), [busy, onBusy]);

  const c = claude.run;
  const x = codex.run;
  const body = (
    <>
      {!hub && <span className="small muted">Waiting for {name} to connect…</span>}
      <EngineLine title="Claude" signedIn={c.at === "done" ? { in: true, who: null } : said.claude}>
        {c.at === "idle" && !said.claude?.in && (
          <button type="button" className="btn btn-sm" disabled={!hub} onClick={() => void claude.begin()}>
            Sign in to Claude
          </button>
        )}
      </EngineLine>
      {c.at !== "idle" && c.at !== "done" && (
        <div className="machine-signing" aria-live="polite" aria-label="Signing in to Claude">
          {c.at === "starting" && <p className="small">Opening Claude’s sign-in page…</p>}
          {c.at === "running" && (
            <>
              <p className="small">
                {c.signIn.state === "checking"
                  ? "Checking the sign-in…"
                  : c.codeAsked
                    ? "Approve it in your browser, then paste the code the page shows."
                    : c.direct
                      ? "Finish signing in in your browser. Desk carries on by itself once you approve."
                      : "Opening Claude’s sign-in page…"}
              </p>
              {c.why && <p className="small state-blocked">{c.why}</p>}
              {c.codeAsked && <CodeField onSend={(code) => void claude.sendCode(code)} />}
              <span className="machine-actions">
                {c.direct && !c.codeAsked && (
                  <button type="button" className="link small" onClick={claude.withCode}>
                    Use a code instead
                  </button>
                )}
                <button type="button" className="link small" onClick={claude.cancel}>
                  Cancel
                </button>
              </span>
            </>
          )}
          {c.at === "failed" && (
            <>
              <p className="small state-blocked" role="alert">
                {c.why}
              </p>
              <span className="machine-actions">
                <button type="button" className="btn btn-sm" onClick={() => void claude.begin()}>
                  Try again
                </button>
              </span>
            </>
          )}
        </div>
      )}
      <EngineLine title="ChatGPT" signedIn={x.at === "done" ? { in: true, who: null } : said.codex}>
        {(x.at === "idle" || x.at === "terminal") && !said.codex?.in && (
          <>
            <span className="small muted">Optional, for Codex.</span>
            {x.at === "idle" && (
              <button type="button" className="btn btn-sm" disabled={!hub} onClick={() => void codex.begin()}>
                Sign in to ChatGPT
              </button>
            )}
          </>
        )}
      </EngineLine>
      {x.at !== "idle" && x.at !== "done" && (
        <div className="machine-signing" aria-live="polite" aria-label="Signing in to ChatGPT">
          {(x.at === "starting" || x.at === "waiting") && <p className="small">Opening ChatGPT’s sign-in page…</p>}
          {x.at === "device" && (
            <>
              <p className="small">Sign in on the page that opened, and type this code there:</p>
              <span className="machine-line">
                <code className="mono">{x.signIn.code}</code>
                <CopyButton text={x.signIn.code} />
              </span>
              <span className="machine-actions">
                <button type="button" className="link small" onClick={() => openUrl(x.signIn.url)}>
                  Open the page again
                </button>
                <button type="button" className="link small" onClick={codex.cancel}>
                  Cancel
                </button>
              </span>
            </>
          )}
          {x.at === "failed" && (
            <>
              <p className="small state-blocked" role="alert">
                {x.why}
              </p>
              <span className="machine-actions">
                <button type="button" className="btn btn-sm" onClick={() => void codex.begin()}>
                  Try again
                </button>
              </span>
            </>
          )}
          {x.at === "terminal" && (
            <span className="machine-signin-terminal">
              <span className="small muted">Desk on {name} is too old to sign ChatGPT in itself. Sign in in a terminal there:</span>
              <span className="machine-line">
                <code className="mono small">{CODEX_LOGIN}</code>
                <button type="button" className="btn btn-sm" onClick={() => openTerminalOn(machine)}>
                  Open a terminal
                </button>
              </span>
            </span>
          )}
        </div>
      )}
    </>
  );

  return boxed ? (
    <div className="machine-box" role="group" aria-label={`Sign in on ${name}`}>
      <span className="ov-label muted">Sign in on {name}</span>
      {body}
    </div>
  ) : (
    <div className="machine-row-signins" role="group" aria-label={`Sign-ins on ${name}`}>
      {body}
    </div>
  );
}
