import { useEffect, useState } from "react";
import { accountsOf, sessionsText, signInStep, useAccounts } from "../engines/accounts";
import { useDesk } from "../hub/store";
import type { AccountSignIn, EngineAccount, EngineInfo } from "../hub/types";
import { openUrl } from "../platform";
import { Confirm } from "../ui/Confirm";
import { plainError } from "../ui/plainError";

/** An engine's accounts in Settings → Engines: several subscription
 *  logins (Work, Personal), one of them the default for new sessions. Each
 *  is signed in once; its sign-in stays on the hub's computer. */
export function Accounts({ engine }: { engine: EngineInfo }) {
  const all = useAccounts((s) => s.accounts);
  const store = useAccounts((s) => s.store);
  const supported = useAccounts((s) => s.supported);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    void useAccounts.getState().load();
  }, []);
  const accounts = accountsOf(all, engine.engine);
  if (supported === false) return null;
  return (
    <div className="accounts" aria-label={`${engine.title} accounts`}>
      <span className="accounts-head">
        <b className="small">Accounts</b>
        {store && <span className="faint small">Signed in once each, kept in {store}.</span>}
      </span>
      {accounts.length === 0 && !adding && (
        <span className="faint small">Sessions run on this computer’s sign-in. Add an account to run some on another subscription.</span>
      )}
      {accounts.length > 0 && (
        <ul className="account-list">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} />
          ))}
        </ul>
      )}
      {accounts.length > 0 && <AutoSwitch />}
      {store === null && supported ? (
        <span className="faint small">This Desk keeps no accounts yet: update Desk to add them.</span>
      ) : adding ? (
        <AddAccount engine={engine} first={accounts.length === 0} onDone={() => setAdding(false)} />
      ) : (
        <span>
          <button type="button" className="btn btn-ghost" onClick={() => setAdding(true)}>
            Add account…
          </button>
        </span>
      )}
    </div>
  );
}

/** "Switch automatically when an account hits its limit": off unless the
 *  person turns it on. Desk never switches back by itself. */
function AutoSwitch() {
  const { hub, fail } = useDesk();
  const on = useAccounts((s) => s.autoSwitch);
  const set = async (next: boolean) => {
    useAccounts.setState({ autoSwitch: next });
    try {
      await hub?.setAutoSwitch(next);
    } catch (e) {
      useAccounts.setState({ autoSwitch: !next });
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

function AccountRow({ account }: { account: EngineAccount }) {
  const { hub, fail } = useDesk();
  const [removing, setRemoving] = useState(false);
  const makeDefault = async (isDefault: boolean) => {
    try {
      await hub?.updateAccount(account.id, { isDefault });
    } catch (e) {
      fail(e);
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
          <p>Desk forgets its sign-in. {account.sessions.length > 0 && `${sessionsText(account)}: they carry on as they are, and move to your default account when they next start.`}</p>
        </Confirm>
      )}
    </li>
  );
}

/** Adding one: a name, then signing in through Claude Code's own page, or
 *  pasting a token made with `claude setup-token`. */
function AddAccount({ engine, first, onDone }: { engine: EngineInfo; first: boolean; onDone: () => void }) {
  const hub = useDesk((s) => s.hub);
  const [name, setName] = useState("");
  const [how, setHow] = useState<"browser" | "paste">("browser");
  const [token, setToken] = useState("");
  const [makeDefault, setMakeDefault] = useState(first);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [signInId, setSignInId] = useState<string | null>(null);
  const signIn = useAccounts((s) => (signInId ? (s.signIns[signInId] ?? null) : null));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hub || !name.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      const added = await hub.addAccount({
        engine: engine.engine,
        name: name.trim(),
        token: how === "paste" ? token.trim() : undefined,
        makeDefault,
      });
      setToken("");
      if (added.kind === "account") onDone();
      else {
        useAccounts.setState((s) => ({ signIns: { ...s.signIns, [added.signIn.id]: added.signIn } }));
        setSignInId(added.signIn.id);
      }
    } catch (err) {
      setProblem(plainError(err));
    } finally {
      setBusy(false);
    }
  };

  if (signIn) return <SigningIn signIn={signIn} onDone={onDone} onPaste={() => (setSignInId(null), setHow("paste"))} />;
  return (
    <form className="account-add" onSubmit={submit} aria-label="Add account">
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Work" maxLength={40} required autoFocus />
      </label>
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
        <label className="field">
          <span>Token from claude setup-token</span>
          <input type="password" className="mono" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} required />
        </label>
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
        <button type="submit" className="btn btn-signal" disabled={busy || !name.trim() || (how === "paste" && !token.trim())}>
          {how === "paste" ? "Add account" : "Sign in…"}
        </button>
      </span>
    </form>
  );
}

function SigningIn({ signIn, onDone, onPaste }: { signIn: AccountSignIn; onDone: () => void; onPaste: () => void }) {
  const hub = useDesk((s) => s.hub);
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const url = signIn.state === "open" || signIn.state === "code" ? signIn.url : null;
  const over = signIn.state === "done" || signIn.state === "failed";
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await hub?.signInCode(signIn.id, code);
      setCode("");
    } catch (err) {
      setProblem(plainError(err));
    }
  };
  const cancel = async () => {
    if (!over) await hub?.cancelSignIn(signIn.id).catch(() => undefined);
    onDone();
  };
  return (
    <div className="account-add" aria-label={`Signing in to ${signIn.name}`} aria-live="polite">
      <b className="small">Signing in to {signIn.name}</b>
      <p className={signIn.state === "failed" ? "state-blocked small" : "small"}>{signInStep(signIn)}</p>
      {url && (
        <span>
          <button type="button" className="btn btn-ghost" onClick={() => openUrl(url)}>
            Open the sign-in page again
          </button>
        </span>
      )}
      {signIn.state === "code" && (
        <form className="field-row" onSubmit={send} aria-label="Sign-in code">
          <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from the page" autoComplete="off" spellCheck={false} />
          <button type="submit" className="btn" disabled={!code.trim()}>
            Send
          </button>
        </form>
      )}
      {problem && <p className="state-blocked small">{problem}</p>}
      <span className="account-actions">
        {signIn.state === "failed" && (
          <button type="button" className="btn btn-ghost" onClick={onPaste}>
            Paste a token instead
          </button>
        )}
        <button type="button" className={over ? "btn" : "btn btn-ghost"} onClick={() => void cancel()}>
          {over ? "Done" : "Cancel"}
        </button>
      </span>
    </div>
  );
}
