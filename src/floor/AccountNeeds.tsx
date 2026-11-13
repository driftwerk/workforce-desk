import { useState } from "react";
import { accountsOf, needText, useAccounts } from "../engines/accounts";
import { useDesk } from "../hub/store";
import type { AccountNeed } from "../hub/types";
import { dayClock } from "./time";

/** Each need once, whatever said it twice. */
export const onceEach = (needs: readonly AccountNeed[]): AccountNeed[] => {
  const seen = new Set<string>();
  return needs.filter((n) => !seen.has(n.id) && (seen.add(n.id), true));
};

/** The Floor's needs about the person's accounts: one at its limit while
 *  another has room ("Switch all"), every one at its limit, one that has
 *  reset after its sessions were moved off ("Switch back"), a session in a
 *  terminal of its own on a full plan, and which account this computer's
 *  sign-in is, when a switch depends on it. */
export function AccountNeeds() {
  const all = useAccounts((s) => s.needs);
  const needs = onceEach(all);
  const left = useAccounts((s) => s.leftInTerminals);
  if (needs.length === 0 && left.length === 0) return null;
  return (
    <>
      {needs.map((n) => (
        <Need key={n.id} need={n} />
      ))}
      {left.length > 0 && (
        <section className="restore account-need" aria-label="Sessions in terminals of their own">
          <div className="restore-head">
            <span className="restore-text">
              <b>{left.length === 1 ? "1 session runs" : `${left.length} sessions run`} in a terminal of its own</b>
              <span className="muted small">Desk can’t move those: start them again there, or sign in there with /login.</span>
            </span>
            <button type="button" className="btn btn-ghost" onClick={() => useAccounts.setState({ leftInTerminals: [] })}>
              OK
            </button>
          </div>
        </section>
      )}
    </>
  );
}

function Need({ need }: { need: AccountNeed }) {
  const hub = useDesk((s) => s.hub);
  const fail = useDesk((s) => s.fail);
  const [busy, setBusy] = useState(false);
  const { title, detail } = needText(need, (iso) => dayClock(iso));
  const move = async (from: string | null, to: string | null) => {
    if (!hub) return;
    setBusy(true);
    try {
      const done = await hub.switchAll(from, to);
      useAccounts.setState({ leftInTerminals: done.inTerminals });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="restore account-need" aria-label={title}>
      <div className="restore-head">
        <span className="restore-text">
          <b>{title}</b>
          {detail && <span className="muted small">{detail}</span>}
          {(need.kind === "limit" || need.kind === "reset") && (
            <span className="muted small">Idle sessions move now; working ones once their turn ends. Desk never switches back by itself.</span>
          )}
        </span>
        {need.kind === "whichSignIn" ? (
          <>
            <WhichSignIn />
            <button type="button" className="btn btn-ghost" onClick={() => hub?.putOffNeed(need.id).catch(fail)}>
              Not now
            </button>
          </>
        ) : need.kind === "signIn" ? (
          <button type="button" className="btn btn-ghost" onClick={() => need.account.id && hub?.dismissSignInProblem(need.account.id).catch(fail)}>
            OK
          </button>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => hub?.putOffNeed(need.id).catch(fail)}>
            Not now
          </button>
        )}
        {need.kind === "limit" && (
          <button type="button" className="btn btn-approve" disabled={busy} onClick={() => void move(need.from.id, need.to.id)}>
            Switch all
          </button>
        )}
        {need.kind === "reset" && (
          <button type="button" className="btn btn-approve" disabled={busy} onClick={() => void move(need.from.id, need.account.id)}>
            Switch back
          </button>
        )}
      </div>
    </section>
  );
}

/** "Which of your accounts is this computer signed in to?": one of them,
 *  or none. Kept until the person changes it in Settings. */
function WhichSignIn() {
  const hub = useDesk((s) => s.hub);
  const fail = useDesk((s) => s.fail);
  const accounts = accountsOf(useAccounts((s) => s.accounts), "claude");
  const [busy, setBusy] = useState(false);
  const answer = async (account: string | null) => {
    if (!hub) return;
    setBusy(true);
    try {
      await hub.setOwnSignIn(account);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {accounts.map((a) => (
        <button key={a.id} type="button" className="btn btn-approve" disabled={busy} onClick={() => void answer(a.id)}>
          {a.name}
        </button>
      ))}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void answer(null)}>
        None of these
      </button>
    </>
  );
}
