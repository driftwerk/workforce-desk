import { create } from "zustand";
import { LOCAL, machineOf, type MachineId } from "../hub/machines";
import { deskListeners, engineListeners, hubOf } from "../hub/store";
import type { AccountNeed, AccountSignIn, Caps, DeskEvent, Engine, EngineAccount, Session, SignIn, SignInProblem } from "../hub/types";
import { passStanding } from "./standing";

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

/** Whether the engine's CLI is signed in by itself on the computer: only
 *  when it says it isn't is its own sign-in no choice. */
export const ownSignInWorks = (signIn: SignIn | null | undefined): boolean => signIn?.state !== "out";

/** What a new session of `engine` starts on when the person picks nothing:
 *  the default account, else the CLI's own sign-in, or, where the CLI isn't
 *  signed in, the first account that is (the order a switch takes them), as
 *  the hub starts it. */
export const defaultChoice = (accounts: readonly EngineAccount[], engine: Engine, ownWorks = true): string =>
  accounts.find((a) => a.engine === engine && a.isDefault)?.id ??
  (ownWorks ? OWN_SIGN_IN : (accountsOf(accounts, engine).find((a) => a.signedIn)?.id ?? OWN_SIGN_IN));

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

/** "Claude", else the first of "Claude 2", "Claude 3"… that no account or
 *  sign-in under way there is called. */
export const freeName = (taken: readonly { name: string }[]): string => {
  const names = new Set(taken.map((a) => a.name.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? "Claude" : `Claude ${n}`;
    if (!names.has(name.toLowerCase())) return name;
  }
};

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

/** "7 sessions", "1 session". */
const sessionsCount = (n: number): string => (n === 1 ? "1 session" : `${n} sessions`);

/** What an account need says, its reset times in `at` (a clock). */
export const needText = (n: AccountNeed, at: (iso: string) => string): { title: string; detail: string | null } => {
  switch (n.kind) {
    case "limit":
      return {
        title: `${n.from.name} hit its limit — switch ${sessionsCount(n.sessions.length)} to ${n.to.name}?`,
        detail: n.resetsAt ? `${n.from.name} resets ${at(n.resetsAt)}.` : null,
      };
    case "allFull":
      return {
        title: "Every Claude account is at its limit",
        detail: n.resets.map(([side, when]) => (when ? `${side.name} resets ${at(when)}` : `${side.name}: no reset time yet`)).join(" · "),
      };
    case "reset":
      return {
        title: `${n.account.name} has reset — switch ${sessionsCount(n.sessions.length)} back from ${n.from.name}?`,
        detail: null,
      };
    case "inTerminal":
      return {
        title: `${n.name} is at ${n.account.name}’s limit in a terminal of its own`,
        detail: `Desk can’t move it: run /login there to use another account, or start it in Desk.${n.resetsAt ? ` ${n.account.name} resets ${at(n.resetsAt)}.` : ""}`,
      };
    case "whichSignIn":
      return {
        title: "Which of your accounts is this computer signed in to?",
        detail: `Claude Code here is signed in${n.email ? ` as ${n.email}` : ""}. Desk asks rather than guess before it moves sessions.`,
      };
    case "signIn":
      return {
        title: n.problem === "notRemoved" ? `${n.account.name}’s sign-in was left behind` : `${n.account.name}’s sign-in can’t be used`,
        detail: problemText({ account: n.account.id ?? "", name: n.account.name, problem: n.problem }, useAccounts.getState().store),
      };
  }
};

/** The plan card's account, by the key its readings have. */
export const accountOfCard = (accounts: readonly EngineAccount[], cardKey: string): EngineAccount | null =>
  accounts.find((a) => a.planKey && cardKey === `${a.engine === "codex" ? "chatgpt" : "claude"}:${a.planKey}`) ?? null;

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

export interface AccountsState {
  accounts: EngineAccount[];
  problems: SignInProblem[];
  needs: AccountNeed[];
  /** Desk moves sessions off an account at its limit by itself. */
  autoSwitch: boolean;
  /** Sessions a switch-all left: they run in terminals of their own. */
  leftInTerminals: string[];
  /** Where the hub keeps their sign-ins; null: this Desk keeps none. */
  store: string | null;
  signIns: Record<string, AccountSignIn>;
  /** The hub has accounts: false once it said it hasn't. */
  supported: boolean | null;
  /** What its Claude Code says of its own sign-in, as last read: whether
   *  "this computer's sign-in" is a choice there. */
  claudeSignIn: SignIn | null;
  load: () => Promise<void>;
}

const makeStore = (machine: MachineId) =>
  create<AccountsState>((set) => ({
    accounts: [],
    needs: [],
    autoSwitch: false,
    leftInTerminals: [],
    problems: [],
    store: null,
    signIns: {},
    supported: null,
    claudeSignIn: null,
    load: async () => {
      const hub = hubOf(machine);
      if (!hub) return;
      // Beside the accounts, never in their way.
      void Promise.resolve()
        .then(() => hub.engines())
        .then((engines) => set({ claudeSignIn: engines?.find((e) => e.engine === "claude")?.signIn ?? null }))
        .catch(() => {});
      try {
        const info = await hub.accounts();
        if (!info) {
          set({ supported: false, accounts: [], store: null });
          return;
        }
        set({
          supported: true,
          accounts: info.accounts,
          needs: info.needs ?? [],
          autoSwitch: info.autoSwitch ?? false,
          problems: info.problems ?? [],
          store: info.store,
          signIns: Object.fromEntries(info.signIns.map((s) => [s.id, s])),
        });
      } catch {
        // Kept as last read; the next snapshot reads again.
      }
    },
  }));

export type AccountsStore = ReturnType<typeof makeStore>;

const stores = new Map<MachineId, AccountsStore>();

/** The accounts of `machine`'s engine (this computer's when none): each
 *  engine keeps its own, and its sessions run on them. */
export const accountsOn = (machine: MachineId = LOCAL): AccountsStore => {
  let store = stores.get(machine);
  if (!store) {
    store = makeStore(machine);
    stores.set(machine, store);
  }
  return store;
};

/** This computer's accounts, as before machines. */
export const useAccounts = accountsOn(LOCAL);

/** What an engine's event says of its accounts, kept in its store. */
const heard = (store: AccountsStore, e: DeskEvent): void => {
  switch (e.type) {
    case "snapshot":
      void store.getState().load();
      return;
    case "accounts":
      store.setState((s) => ({ accounts: e.accounts, problems: e.problems ?? [], needs: e.needs ?? [], autoSwitch: e.autoSwitch ?? s.autoSwitch, supported: true }));
      return;
    case "accountSignIn":
      store.setState((s) => ({ signIns: { ...s.signIns, [e.signIn.id]: e.signIn } }));
      return;
    default:
      return;
  }
};

let passing: ReturnType<typeof setTimeout> | null = null;

/** Soon after any computer's accounts change: what each knows of their
 *  plans is passed to the others ([`passStanding`]). A machine's accounts
 *  stay its own; only their standing travels. */
const passSoon = () => {
  if (passing) return;
  passing = setTimeout(() => {
    passing = null;
    void passStanding((m) => accountsOn(m).getState().accounts, [...stores.keys()]);
  }, 1000);
};

deskListeners.add((e) => {
  heard(useAccounts, e);
  if (e.type === "accounts") passSoon();
});
// A machine's accounts are its own: they never reach this computer's.
engineListeners.add((e) => {
  const machine = machineOf(e);
  if (machine !== LOCAL) {
    heard(accountsOn(machine), e);
    if (e.type === "accounts") passSoon();
  }
});
