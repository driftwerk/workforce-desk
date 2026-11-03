import { create } from "zustand";
import { deskListeners, useDesk } from "../hub/store";
import type { AccountSignIn, Caps, Engine, EngineAccount, Session, SignInProblem } from "../hub/types";

/** The choice that runs a session on the CLI's own sign-in. */
export const OWN_SIGN_IN = "own";

/** What the account picker and the pane say for the CLI's own sign-in. */
export const OWN_SIGN_IN_LABEL = "This computer’s sign-in";

/** Whether an engine's sessions can each run on one of the person's
 *  accounts. */
export const hasAccounts = (caps: Caps | null | undefined): boolean => caps?.accounts === "token";

/** An engine's accounts, the default first. */
export const accountsOf = (accounts: readonly EngineAccount[], engine: Engine): EngineAccount[] =>
  accounts.filter((a) => a.engine === engine).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

/** What a new session of `engine` starts on when the person picks nothing:
 *  the default account, else the CLI's own sign-in. */
export const defaultChoice = (accounts: readonly EngineAccount[], engine: Engine): string =>
  accounts.find((a) => a.engine === engine && a.isDefault)?.id ?? OWN_SIGN_IN;

/** The picker's choice as the hub takes it: an account's id, or null. */
export const accountOfChoice = (choice: string): string | null => (choice === OWN_SIGN_IN ? null : choice);

/** "Claude Code · Work", or the engine alone on its own sign-in. */
export const withAccount = (engine: string, s: Pick<Session, "account">): string => (s.account ? `${engine} · ${s.account.name}` : engine);

/** What a session's card says of a switch that waits for its turn. */
export const switchingText = (s: Pick<Session, "switchingTo">): string | null =>
  s.switchingTo ? `Moves to ${s.switchingTo.name} when this turn ends` : null;

/** How many sessions run on an account, in words. */
export const sessionsText = (a: EngineAccount): string =>
  a.sessions.length === 0 ? "No sessions on it now" : a.sessions.length === 1 ? "1 session on it" : `${a.sessions.length} sessions on it`;

/** What a sign-in under way says. */
export const signInStep = (s: AccountSignIn): string => {
  switch (s.state) {
    case "starting":
      return "Opening Claude’s sign-in page…";
    case "open":
      return "Finish signing in in your browser.";
    case "code":
      return "If the page shows a code, paste it here.";
    case "checking":
      return "Checking the sign-in…";
    case "done":
      return `${s.name} is added.`;
    case "failed":
      return s.why;
  }
};

/** What a sign-in problem says. */
export const problemText = (p: SignInProblem, store: string | null): string => {
  const where = store ?? "the hub's store";
  switch (p.problem) {
    case "gone":
      return `${p.name}’s sign-in is no longer in ${where}: add the account again. Nothing is switched to it.`;
    case "unreadable":
      return `Desk couldn’t read ${p.name}’s sign-in from ${where} just now, so nothing was switched. Unlock the keychain, then try again.`;
    case "notRemoved":
      return `${p.name} is removed, but Desk couldn’t delete its sign-in from ${where}. Delete it there yourself.`;
  }
};

interface AccountsState {
  accounts: EngineAccount[];
  problems: SignInProblem[];
  /** Where the hub keeps their sign-ins; null: this Desk keeps none. */
  store: string | null;
  signIns: Record<string, AccountSignIn>;
  /** The hub has accounts: false once it said it hasn't. */
  supported: boolean | null;
  load: () => Promise<void>;
}

export const useAccounts = create<AccountsState>((set) => ({
  accounts: [],
  problems: [],
  store: null,
  signIns: {},
  supported: null,
  load: async () => {
    const hub = useDesk.getState().hub;
    if (!hub) return;
    try {
      const info = await hub.accounts();
      if (!info) {
        set({ supported: false, accounts: [], store: null });
        return;
      }
      set({
        supported: true,
        accounts: info.accounts,
        problems: info.problems ?? [],
        store: info.store,
        signIns: Object.fromEntries(info.signIns.map((s) => [s.id, s])),
      });
    } catch {
      // Kept as last read; the next snapshot reads again.
    }
  },
}));

deskListeners.add((e) => {
  switch (e.type) {
    case "snapshot":
      void useAccounts.getState().load();
      return;
    case "accounts":
      useAccounts.setState({ accounts: e.accounts, problems: e.problems ?? [], supported: true });
      return;
    case "accountSignIn":
      useAccounts.setState((s) => ({ signIns: { ...s.signIns, [e.signIn.id]: e.signIn } }));
      return;
    default:
      return;
  }
});
