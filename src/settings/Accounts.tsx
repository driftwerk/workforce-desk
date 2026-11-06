import { useEffect, useId, useRef, useState } from "react";
import { useClaudeSignIn } from "../engines/signIn";
import { accountsOf, accountsOn, freeName, ownSignInWorks, problemText, sessionsText, useAccounts, type AccountsStore } from "../engines/accounts";
import { LOCAL, type MachineId } from "../hub/machines";
import { useDesk, useHubOf } from "../hub/store";
import type { EngineAccount, EngineInfo } from "../hub/types";
import { native as realNative, type MachineNative, type Shared } from "../machines/native";
import { useHost } from "../shell/host";
import { Confirm } from "../ui/Confirm";
import { plainError } from "../ui/plainError";

/** An engine's accounts in Settings → Engines, on this computer or one of
 *  the person's machines (`machine`): several subscription logins (Work,
 *  Personal), one of them the default for new sessions. Each is signed in
 *  once; its sign-in stays on that engine's computer. A machine can take
 *  this computer's accounts ("Use this computer's accounts"). */
export function Accounts({
  engine,
  machine = LOCAL,
  name,
  native = realNative,
  canAdd = true,
  onShared,
}: {
  engine: EngineInfo;
  machine?: MachineId;
  /** The machine's name. */
  name?: string;
  native?: MachineNative;
  /** Whether "Add account…" is offered here: a machine signs its accounts
   *  in through its own sign-in, beside this block. */
  canAdd?: boolean;
  /** This computer's accounts were copied there. */
  onShared?: () => void;
}) {
  const store = accountsOn(machine);
  const all = store((s) => s.accounts);
  const where = store((s) => s.store);
  const supported = store((s) => s.supported);
  const problems = store((s) => s.problems);
  const hub = useHubOf(machine);
  const fail = useDesk((s) => s.fail);
  const [adding, setAdding] = useState<false | "form" | "quick">(false);
  const here = hereOf(useHost((h) => h.platform));
  useEffect(() => {
    void store.getState().load();
  }, [store, hub]);
  const accounts = accountsOf(all, engine.engine);
  if (supported === false) return null;
  return (
    <div className="accounts" aria-label={`${engine.title} accounts`}>
      <span className="accounts-head">
        <b className="small">Accounts</b>
        {where && <span className="faint small">Signed in once each, kept in {machine === LOCAL ? where : `${name ?? machine}’s private file store`}.</span>}
      </span>
      {problems.map((p) => (
        <p key={p.account} className="state-blocked small account-problem" role="status">
          {problemText(p, where)}{" "}
          <button type="button" className="link" onClick={() => hub?.dismissSignInProblem(p.account).catch(fail)}>
            OK
          </button>
        </p>
      ))}
      {accounts.length === 0 && !adding && machine === LOCAL && (
        <span className="faint small">Sessions run on this computer’s sign-in. Add an account to run some on another subscription.</span>
      )}
      {accounts.length > 0 && (
        <ul className="account-list">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} machine={machine} store={store} others={accounts} />
          ))}
        </ul>
      )}
      {accounts.length > 0 && <AutoSwitch machine={machine} store={store} />}
      {machine !== LOCAL && engine.engine === "claude" && where && <UseMine machine={machine} name={name ?? machine} native={native} store={store} onShared={onShared} ownWorks={ownSignInWorks(engine.signIn)} />}
      {where === null && supported ? (
        <span className="faint small">This Desk keeps no accounts yet: update Desk to add them.</span>
      ) : !canAdd ? null : adding ? (
        <AddAccount
          engine={engine}
          first={accounts.length === 0}
          onDone={() => setAdding(false)}
          machine={machine}
          where={machine === LOCAL ? here : (name ?? machine)}
          native={native}
          start={adding === "quick" ? freeName(all) : undefined}
        />
      ) : (
        <span className="account-actions-start">
          {/* A machine with no account yet signs in at once, as "Claude". */}
          {machine !== LOCAL && accounts.length === 0 && (
            <button type="button" className="btn btn-sm btn-signal" onClick={() => setAdding("quick")}>
              Sign in…
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => setAdding("form")}>
            Add account…
          </button>
        </span>
      )}
    </div>
  );
}

/** Whether `machine`'s engine has a Claude account signed in. */
export const useHasAccount = (machine: MachineId): boolean => accountsOn(machine)((s) => s.accounts.some((a) => a.engine === "claude" && a.signedIn));

/** What this computer is called: "this Mac" on macos, else "this computer". */
const hereOf = (platform: string): string => (platform === "macos" ? "this Mac" : "this computer");

/** What copying this computer's accounts to a machine did, in words. */
export const sharedText = (r: Shared, name: string, here: string): string[] => {
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
  const lines: string[] = [];
  if (r.copied.length) lines.push(`${list(r.copied)} ${r.copied.length === 1 ? "is" : "are"} on ${name} now, copied from ${here}.`);
  if (r.already.length) lines.push(`${list(r.already)} ${r.already.length === 1 ? "was" : "were"} on ${name} already.`);
  for (const f of r.failed) lines.push(`${f.name} wasn’t copied: ${f.why}`);
  if (r.madeDefault) lines.push(`New sessions on ${name} start on ${r.madeDefault}: Claude Code isn’t signed in there by itself.`);
  if (r.copied.length && r.autoSwitch) lines.push(`${name} moves its sessions to another account at a limit by itself, as ${here} does.`);
  return lines;
};

/** "Use this computer's accounts" on a machine: its Claude accounts
 *  it hasn't got, copied there after one native question. */
function UseMine({
  machine,
  name,
  native,
  store,
  onShared,
  ownWorks,
}: {
  machine: MachineId;
  name: string;
  native: MachineNative;
  store: AccountsStore;
  onShared?: () => void;
  /** Claude Code there may be signed in by itself (it doesn't say it isn't). */
  ownWorks: boolean;
}) {
  const here = hereOf(useHost((h) => h.platform));
  const mine = useAccounts((s) => s.accounts);
  const theirs = store((s) => s.accounts);
  const hubOfMachine = useHubOf(machine);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ lines: string[]; failed: boolean } | null>(null);
  useEffect(() => {
    void useAccounts.getState().load();
  }, []);
  const missing = mine.filter((a) => a.engine === "claude" && a.signedIn && !theirs.some((t) => t.engine === "claude" && t.name.toLowerCase() === a.name.toLowerCase()));
  // Logged out there with no default it can sign in by (as an earlier copy
  // left it): the account its hub starts sessions on, offered to be made
  // the default, in the machine's order (the default, then the oldest).
  const theirsSignedIn = theirs
    .filter((t) => t.engine === "claude" && t.signedIn)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
  const brokenDefault = theirs.find((t) => t.engine === "claude" && t.isDefault && !t.signedIn) ?? null;
  const toDefault =
    !ownWorks && missing.length === 0 && theirsSignedIn.length > 0 && !theirsSignedIn[0]!.isDefault ? theirsSignedIn[0]! : null;
  if (missing.length === 0 && !toDefault && !said) return null;
  const makeDefault = async (account: EngineAccount) => {
    const hub = hubOfMachine;
    if (!hub) return;
    setBusy(true);
    setSaid(null);
    try {
      await hub.updateAccount(account.id, { isDefault: true });
      setSaid({ lines: [`New sessions on ${name} start on ${account.name}.`], failed: false });
      await store.getState().load();
    } catch (e) {
      setSaid({ lines: [plainError(e)], failed: true });
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await native.shareAccounts(machine);
      if (!r.cancelled) setSaid({ lines: sharedText(r, name, here), failed: r.failed.length > 0 });
      await store.getState().load();
      if (!r.cancelled && r.failed.length === 0) onShared?.();
    } catch (e) {
      setSaid({ lines: [plainError(e)], failed: true });
    } finally {
      setBusy(false);
    }
  };
  const names = missing.map((a) => a.name);
  return (
    <div className="account-share" role="group" aria-label={`Use ${here}’s accounts`}>
      {toDefault && (
        <span className="account-share-row">
          <span className="small">
            {brokenDefault
              ? `Claude Code isn’t signed in on ${name}, and its default, ${brokenDefault.name}, can’t sign in.`
              : `Claude Code isn’t signed in on ${name}, and none of its accounts is the default.`}{" "}
            {!brokenDefault && <span className="faint">New sessions there start on {toDefault.name} until one is.</span>}
          </span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void makeDefault(toDefault)}>
            {`Make ${toDefault.name} the default`}
          </button>
        </span>
      )}
      {missing.length > 0 && (
        <span className="account-share-row">
          <span className="small">
            {here[0]!.toUpperCase() + here.slice(1)} has {names.length === 1 ? "the account" : "the accounts"} {names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}.{" "}
            <span className="faint">Copied over SSH into {name}’s private file store; {here} keeps its own.</span>
          </span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void copy()}>
            {busy ? "Copying…" : `Use ${here}’s accounts…`}
          </button>
        </span>
      )}
      {said?.lines.map((l) => (
        <span key={l} className={`small ${said.failed && l.includes("wasn’t copied") ? "state-blocked" : said.failed && said.lines.length === 1 ? "state-blocked" : ""}`} role="status">
          {l}
        </span>
      ))}
    </div>
  );
}

/** "Switch automatically when an account hits its limit": off unless the
 *  person turns it on. Desk never switches back by itself. */
function AutoSwitch({ machine, store }: { machine: MachineId; store: AccountsStore }) {
  const hub = useHubOf(machine);
  const fail = useDesk((s) => s.fail);
  const on = store((s) => s.autoSwitch);
  const set = async (next: boolean) => {
    store.setState({ autoSwitch: next });
    try {
      await hub?.setAutoSwitch(next);
    } catch (e) {
      store.setState({ autoSwitch: !next });
      fail(e);
    }
  };
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={on} onChange={(e) => void set(e.target.checked)} />
      <span>
        <b className="small">Switch automatically when an account hits its limit</b>
        <span className="muted small">Desk moves its sessions to an account with room and says so on the Floor. It asks before switching back.</span>
      </span>
    </label>
  );
}

function AccountRow({ account, machine, store, others }: { account: EngineAccount; machine: MachineId; store: AccountsStore; others: EngineAccount[] }) {
  const hub = useHubOf(machine);
  const fail = useDesk((s) => s.fail);
  const [removing, setRemoving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const makeDefault = async (isDefault: boolean) => {
    try {
      await hub?.updateAccount(account.id, { isDefault });
    } catch (e) {
      fail(e);
    }
  };
  // Sessions on the engine's other accounts: "Switch to" moves them here.
  const elsewhere = others.filter((o) => o.id !== account.id && o.sessions.length > 0);
  /** Every session on another account moves here, and new ones start here. */
  const switchHere = async () => {
    if (!hub) return;
    setSwitching(true);
    try {
      const left: string[] = [];
      for (const from of elsewhere) left.push(...(await hub.switchAll(from.id, account.id)).inTerminals);
      if (!account.isDefault) await hub.updateAccount(account.id, { isDefault: true });
      store.setState({ leftInTerminals: left });
      await store.getState().load();
    } catch (e) {
      fail(e);
    } finally {
      setSwitching(false);
    }
  };
  return (
    <li className="account-row">
      <span className="account-name">
        <b>{account.name}</b>
        {account.isDefault && <span className="chip chip-default">Default</span>}
      </span>
      <span className={account.signedIn ? "faint small" : "state-blocked small"}>
        {account.signedIn ? sessionsText(account) : "Its sign-in is gone: remove it and add it again"}
      </span>
      <span className="account-actions">
        {account.signedIn && elsewhere.length > 0 && (
          <button type="button" className="btn btn-ghost" disabled={switching} onClick={() => void switchHere()}>
            {switching ? "Switching…" : `Switch to ${account.name}`}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => void makeDefault(!account.isDefault)}>
          {account.isDefault ? "Not the default" : "Make default"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setRemoving(true)}>
          Remove…
        </button>
      </span>
      {removing && (
        <Confirm
          title={`Remove “${account.name}”?`}
          action="Remove account"
          onConfirm={async () => {
            await hub?.removeAccount(account.id);
          }}
          onClose={() => setRemoving(false)}
        >
          <p>
            Desk forgets its sign-in{machine === LOCAL ? "" : " there; this computer’s own copy stays"}. {account.sessions.length > 0 && `${sessionsText(account)}: they carry on as they are, and move to your default account when they next start.`}
          </p>
        </Confirm>
      )}
    </li>
  );
}

/** Adding one: a name, then signing in through Claude Code's own page
 *  (run by the engine's hub, its page opened here), or pasting a token
 *  made with `claude setup-token`. The same on this computer and on each
 *  machine. */
function AddAccount({
  engine,
  first,
  onDone,
  machine,
  where,
  native,
  start,
}: {
  engine: EngineInfo;
  first: boolean;
  onDone: () => void;
  machine: MachineId;
  where: string;
  native: MachineNative;
  /** Signs in at once under this name, as the default (a machine's first). */
  start?: string;
}) {
  const hub = useHubOf(machine);
  const [name, setName] = useState("");
  const [how, setHow] = useState<"browser" | "paste">("browser");
  const [token, setToken] = useState("");
  const [makeDefault, setMakeDefault] = useState(first);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const claude = useClaudeSignIn(machine, where, native);
  const nameId = useId();
  const tokenId = useId();
  const started = useRef(false);
  useEffect(() => {
    if (!start || started.current || !hub) return;
    started.current = true;
    void claude.begin(start, true);
  });

  const submit = async () => {
    if (!hub || !name.trim()) return;
    setProblem(null);
    if (how === "browser") return void claude.begin(name.trim(), makeDefault);
    setBusy(true);
    try {
      const added = await hub.addAccount({ engine: engine.engine, name: name.trim(), token: token.trim(), makeDefault });
      setToken("");
      if (added.kind === "account") onDone();
    } catch (err) {
      setProblem(plainError(err));
    } finally {
      setBusy(false);
    }
  };

  if (claude.run.at !== "idle")
    return (
      <SigningIn
        claude={claude}
        onDone={onDone}
        onPaste={() => {
          claude.reset();
          setHow("paste");
        }}
      />
    );
  // A group, not a form: it sits inside the Add card's own form.
  return (
    <div
      className="account-add"
      role="group"
      aria-label="Add account"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <div className="field">
        <label htmlFor={nameId}>Name</label>
        <input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="Work" maxLength={40} required autoFocus />
      </div>
      <div className="seg" role="radiogroup" aria-label="Sign in">
        <button type="button" role="radio" aria-checked={how === "browser"} onClick={() => setHow("browser")}>
          Sign in with Claude
        </button>
        <button type="button" role="radio" aria-checked={how === "paste"} onClick={() => setHow("paste")}>
          Paste a token
        </button>
      </div>
      {how === "browser" ? (
        <p className="faint small">Desk opens Claude’s sign-in page. Sign in there with the account you want; Desk keeps the sign-in without showing it.</p>
      ) : (
        <div className="field">
          <label htmlFor={tokenId}>Token from claude setup-token</label>
          <input id={tokenId} type="password" className="mono" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} required />
        </div>
      )}
      <p className="faint small">An account’s sessions can’t use claude.ai connectors or Remote Control: its sign-in only makes model requests.</p>
      <label className="check small">
        <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
        New sessions start on it
      </label>
      {problem && <p className="state-blocked small">{problem}</p>}
      <span className="account-actions">
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn btn-signal" disabled={busy || !name.trim() || (how === "paste" && !token.trim())} onClick={() => void submit()}>
          {how === "paste" ? "Add account" : "Sign in…"}
        </button>
      </span>
    </div>
  );
}

/** The code field: a group, not a form, as it may sit inside another. */
export function CodeField({ onSend, focus = false }: { onSend: (code: string) => void; focus?: boolean }) {
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
        autoFocus={focus}
      />
      <button type="button" className="btn" disabled={!code.trim()} onClick={send}>
        Send
      </button>
    </span>
  );
}

/** A Claude sign-in under way, as SignInStates draws it: opening (30 s),
 *  waiting for approval (10 minutes) or a code, added, or failed with why. */
export function SigningIn({ claude, onDone, onPaste }: { claude: ReturnType<typeof useClaudeSignIn>; onDone: () => void; onPaste: () => void }) {
  const r = claude.run;
  if (r.at === "idle") return null;
  return (
    <div className="account-add" role="group" aria-label={`Signing in to ${r.name}`} aria-live="polite">
      <b className="small">Signing in to {r.name}</b>
      {r.at === "opening" && (
        <>
          <p className="small">{r.checking ? "Checking the sign-in…" : "Opening Claude’s sign-in page…"}</p>
          <span className="faint small">If the page hasn’t opened in 30 s, Desk stops and says why.</span>
        </>
      )}
      {r.at === "waiting" &&
        (r.codeAsked ? (
          <>
            {r.why ? <p className="small state-blocked">{r.why}</p> : <p className="small">{r.checking ? "Checking the sign-in…" : "If the page shows a code, paste it here."}</p>}
            <CodeField onSend={(code) => void claude.sendCode(code)} focus />
            {r.page && (
              <span>
                <button type="button" className="btn btn-ghost" onClick={claude.reopen}>
                  Open the sign-in page again
                </button>
              </span>
            )}
          </>
        ) : (
          <>
            <p className="small">{r.checking ? "Checking the sign-in…" : r.page ? "Finish signing in in your browser." : "Opening Claude’s sign-in page…"}</p>
            {r.why && <p className="small state-blocked">{r.why}</p>}
            <span className="account-links">
              {r.page && (
                <button type="button" className="btn btn-ghost" onClick={claude.reopen}>
                  Open the sign-in page again
                </button>
              )}
              <button type="button" className="link small" onClick={claude.withCode}>
                Use a code instead
              </button>
            </span>
            <span className="faint small">Desk carries on by itself once you approve. It waits up to 10 minutes, then stops the sign-in.</span>
          </>
        ))}
      {r.at === "done" && (
        <p className="small">
          <span className="state-done">{r.name} is added.</span>
        </p>
      )}
      {r.at === "failed" && (
        <>
          <p className="small state-blocked" role="alert">
            {r.why}
          </p>
          <span className="account-actions">
            <button type="button" className="btn btn-ghost" onClick={onPaste}>
              Paste a token instead
            </button>
          </span>
        </>
      )}
      <span className="account-actions">
        {r.at === "done" ? (
          <button type="button" className="btn" onClick={onDone}>
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                claude.cancel();
                onDone();
              }}
            >
              Cancel
            </button>
            {r.at === "failed" && (
              <button type="button" className="btn" onClick={claude.again}>
                Try again
              </button>
            )}
          </>
        )}
      </span>
    </div>
  );
}
