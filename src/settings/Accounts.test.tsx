import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAccounts } from "../engines/accounts";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { AccountSignIn, EngineAccount, EngineInfo } from "../hub/types";
import { Accounts } from "./Accounts";
import { accountsOn } from "../engines/accounts";
import { useProviders } from "../providers/store";
import type { Provider } from "../hub/providers";
import type { MachineNative } from "../machines/native";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
const opened = vi.fn();
// Desk's own sign-in on this computer: started, and its progress told.
const startLogin = vi.fn(async (_plan: string, _to?: unknown) => {});
let progress: ((plan: string, p: unknown) => void) | null = null;
vi.mock("../platform", () => ({
  inApp: false,
  openUrl: (u: string) => opened(u),
  startLogin: (plan: string, to?: unknown) => startLogin(plan, to),
  cliInstalled: vi.fn(async () => true),
  installCli: vi.fn(async () => {}),
  cancelLogin: vi.fn(async () => {}),
  sendLoginCode: vi.fn(async () => {}),
  onLoginProgress: vi.fn(async (f: (plan: string, p: unknown) => void) => {
    progress = f;
    return () => {};
  }),
  onInstallProgress: vi.fn(async () => () => {}),
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  subscribe: (p: Promise<() => void>) => () => void p.then((f) => f()),
  invoke: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

beforeEach(() => {
  useAccounts.setState({ accounts: [], store: null, signIns: {}, supported: null });
  useProviders.setState({ providers: [{ id: "claude-code", connected: false } as unknown as Provider], loaded: true });
  startLogin.mockClear();
  progress = null;
});
afterEach(cleanup);

const claude: EngineInfo = {
  engine: "claude",
  title: "Claude Code",
  program: "claude",
  installed: true,
  version: "2.1.300",
  signIn: { state: "in", via: "plan", who: "sam@example.com", plan: "max" },
  views: ["terminal"],
  caps: {},
};

const account = (id: string, name: string, more: Partial<EngineAccount> = {}): EngineAccount => ({
  id,
  engine: "claude",
  name,
  isDefault: false,
  signedIn: true,
  sessions: [],
  createdAt: "2026-11-03T09:00:00Z",
  ...more,
});

const withHub = (hub: Partial<Record<keyof DeskHub, unknown>>, accounts: EngineAccount[] = [], store: string | null = "the keychain") => {
  const full = { accounts: vi.fn(async () => ({ accounts, store, signIns: [] })), ...hub };
  useDesk.setState({ hub: full as unknown as DeskHub, fail: vi.fn() });
  return full;
};

const signIn = (s: Partial<AccountSignIn> & Pick<AccountSignIn, "state">): AccountSignIn => ({ id: "i-1", engine: "claude", name: "Personal", ...s }) as AccountSignIn;

it("says sessions run on this computer's sign-in until an account is added", async () => {
  withHub({});
  render(<Accounts engine={claude} />);
  await act(async () => {});
  expect(screen.getByText(/Sessions run on this computer’s sign-in/)).toBeTruthy();
  expect(screen.getByText("Signed in once each, kept in the keychain.")).toBeTruthy();
  // No account yet: signing in comes first, with no name to give.
  expect(screen.getByRole("button", { name: "Sign in…" })).toBeTruthy();
});

it("lists each account, the default marked, its sessions, and one whose sign-in is gone", async () => {
  const updateAccount = vi.fn(async () => ({}));
  withHub({ updateAccount }, [account("a-w", "Work", { isDefault: true, sessions: ["s1", "s2"] }), account("a-p", "Personal", { signedIn: false })]);
  render(<Accounts engine={claude} />);
  await act(async () => {});
  expect(screen.getByText("Default")).toBeTruthy();
  expect(screen.getByText("2 sessions on it")).toBeTruthy();
  expect(screen.getByText("Its sign-in is gone.")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Sign in again" })).toHaveLength(1);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make default" })));
  expect(updateAccount).toHaveBeenCalledWith("a-p", { isDefault: true });
});

it("signs one in first, with no name asked, for coding sessions and the crew both; then names it", async () => {
  const updateAccount = vi.fn(async () => ({}));
  withHub({ updateAccount }, [account("a-w", "Work", { isDefault: true })]);
  render(<Accounts engine={claude} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Add account…" }));
  expect(screen.queryByLabelText("Name")).toBeNull();
  // The crew's Claude plan isn't signed in: this sign-in can be it too.
  const crew = screen.getByRole("checkbox", { name: "Use it for your crew too" }) as HTMLInputElement;
  expect(crew.checked).toBe(true);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in with Claude" })));
  expect(startLogin).toHaveBeenCalledWith("claude", { agents: true, account: { name: "Claude", makeDefault: false } });
  await act(async () => progress?.("claude", { state: "browser", url: "https://claude.ai/oauth/authorize?x=1" }));
  expect(screen.getByText(/Finish signing in in your browser/)).toBeTruthy();
  await act(async () => progress?.("claude", { state: "done", account: "a-new" }));
  // Signed in: named now, or kept as "Claude".
  const field = screen.getByLabelText("Name") as HTMLInputElement;
  expect(field.value).toBe("Claude");
  fireEvent.change(field, { target: { value: "Personal" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
  expect(updateAccount).toHaveBeenCalledWith("a-new", { name: "Personal" });
});

it("signs only the account in when the crew is signed in already, or the person says so", async () => {
  useProviders.setState({ providers: [{ id: "claude-code", connected: true } as unknown as Provider] });
  withHub({});
  render(<Accounts engine={claude} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Sign in…" }));
  expect(screen.queryByRole("checkbox", { name: "Use it for your crew too" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in with Claude" })));
  expect(startLogin).toHaveBeenCalledWith("claude", { agents: false, account: { name: "Claude", makeDefault: true } });
});

it("signs an account whose sign-in is gone in again, keeping it as it is", async () => {
  withHub({}, [account("a-p", "Personal", { signedIn: false })]);
  render(<Accounts engine={claude} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(screen.queryByRole("checkbox", { name: "Use it for your crew too" })).toBeNull();
  await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Sign in again" }).at(-1)!));
  expect(startLogin).toHaveBeenCalledWith("claude", { agents: false, account: { again: "a-p" } });
  await act(async () => progress?.("claude", { state: "done", account: "a-p" }));
  expect(screen.getByText("Personal is signed in again.")).toBeTruthy();
});

it("signs a machine's account in again through its own hub", async () => {
  const signInAgain = vi.fn(async () => ({ kind: "signIn", signIn: signIn({ id: "i-9", name: "Personal", state: "starting" }) }));
  const hub = { accounts: vi.fn(async () => ({ accounts: [account("a-p", "Personal", { signedIn: false })], store: "a file", signIns: [] })), signInAgain, cancelSignIn: vi.fn(async () => {}) };
  useDesk.setState({ engines: { devbox: { hub: hub as unknown as DeskHub, connected: true, loaded: true, error: null } } as never, fail: vi.fn() });
  render(<Accounts engine={claude} machine="devbox" name="devbox" native={native} />);
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in again" })));
  expect(signInAgain).toHaveBeenCalledWith("a-p", { remote: true });
  await act(async () => accountsOn("devbox").setState((st) => ({ signIns: { ...st.signIns, "i-9": signIn({ id: "i-9", name: "Personal", state: "done", account: "a-p" }) } })));
  expect(screen.getByText("Personal is signed in again.")).toBeTruthy();
});

it("adds an account from a pasted token, sent once and never shown", async () => {
  const addAccount = vi.fn(async () => ({ kind: "account", account: account("a-w", "Work") }));
  withHub({ addAccount });
  render(<Accounts engine={claude} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Sign in…" }));
  fireEvent.click(screen.getByRole("button", { name: "Paste a token instead" }));
  // Named already, as a sign-in would be; the person may change it.
  expect((screen.getByPlaceholderText("Work") as HTMLInputElement).value).toBe("Claude");
  fireEvent.change(screen.getByPlaceholderText("Work"), { target: { value: "Work" } });
  const field = screen.getByLabelText("Sign-in token") as HTMLInputElement;
  expect(field.type).toBe("password");
  fireEvent.change(field, { target: { value: "sk-ant-oat01-pasted" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add account" })));
  expect(addAccount).toHaveBeenCalledWith({ engine: "claude", name: "Work", token: "sk-ant-oat01-pasted", makeDefault: true });
  expect(screen.queryByLabelText("Sign-in token")).toBeNull();
});

it("says why the hub refused an account", async () => {
  withHub({ addAccount: vi.fn(async () => Promise.reject(new Error("Claude Code didn't accept that token"))) });
  render(<Accounts engine={claude} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Sign in…" }));
  fireEvent.click(screen.getByRole("button", { name: "Paste a token instead" }));
  fireEvent.change(screen.getByPlaceholderText("Work"), { target: { value: "Work" } });
  fireEvent.change(screen.getByLabelText("Sign-in token"), { target: { value: "bad" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add account" })));
  expect(screen.getByText(/didn't accept that token/)).toBeTruthy();
});

/** Desk's native side, as a machine's sign-in uses it. */
const native = {
  signInForward: vi.fn(async () => {}),
  signInForwardStop: vi.fn(async () => {}),
  openSignInPage: vi.fn(async () => {}),
} as unknown as MachineNative;

/** A machine's hub, which signs its accounts in itself. */
const onDevbox = (hub: Record<string, unknown>) => {
  const full = { accounts: vi.fn(async () => ({ accounts: [], store: "a file", signIns: [] })), cancelSignIn: vi.fn(async () => {}), ...hub };
  useDesk.setState({ engines: { devbox: { hub: full as unknown as DeskHub, connected: true, loaded: true, error: null } } as never, fail: vi.fn() });
  return full;
};

it("signs in through Claude's page on a machine at once, as Claude: opening, a code, checking, then naming it", async () => {
  const addAccount = vi.fn(async () => ({ kind: "signIn", signIn: signIn({ state: "starting", name: "Claude" }) }));
  const signInCode = vi.fn(async () => signIn({ state: "code", url: null }));
  const updateAccount = vi.fn(async () => ({}));
  onDevbox({ addAccount, signInCode, updateAccount });
  render(<Accounts engine={claude} machine="devbox" name="devbox" native={native} />);
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in…" })));
  expect(addAccount).toHaveBeenCalledWith({ engine: "claude", name: "Claude", makeDefault: true, remote: true });
  expect(screen.getByText("Opening Claude’s sign-in page…")).toBeTruthy();

  const move = (s: AccountSignIn) => act(async () => accountsOn("devbox").setState((st) => ({ signIns: { ...st.signIns, [s.id]: { ...s, name: "Claude" } } })));
  // The page shows a code: it's asked for.
  await move(signIn({ state: "code", url: "https://claude.ai/oauth/authorize?x=1" }));
  fireEvent.change(screen.getByPlaceholderText("Code from the page"), { target: { value: "c0de" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
  expect(signInCode).toHaveBeenCalledWith("i-1", "c0de");

  await move(signIn({ state: "checking" }));
  expect(screen.getByText("Checking the sign-in…")).toBeTruthy();
  await move(signIn({ state: "done", account: "a-p" }));
  expect(screen.getByText("Signed in.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Personal" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
  expect(updateAccount).toHaveBeenCalledWith("a-p", { name: "Personal" });
});

it("offers pasting a token when the sign-in fails, saying why", async () => {
  const addAccount = vi.fn(async () => ({ kind: "signIn", signIn: signIn({ state: "starting", name: "Claude" }) }));
  onDevbox({ addAccount });
  render(<Accounts engine={claude} machine="devbox" name="devbox" native={native} />);
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in…" })));
  await act(async () =>
    accountsOn("devbox").setState({ signIns: { "i-1": signIn({ state: "failed", name: "Claude", why: "Desk couldn't read the token from Claude Code: paste it instead" }) } }),
  );
  expect(screen.getByText(/paste it instead/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Paste a token instead" }));
  expect(screen.getByLabelText("Sign-in token")).toBeTruthy();
});

it("asks before removing an account, saying what happens to its sessions", async () => {
  const removeAccount = vi.fn(async () => undefined);
  withHub({ removeAccount }, [account("a-w", "Work", { sessions: ["s1"] })]);
  render(<Accounts engine={claude} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
  expect(screen.getByText(/move to your default account when they next start/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove account" })));
  expect(removeAccount).toHaveBeenCalledWith("a-w");
});

it("says when this Desk keeps no accounts, and shows nothing for a hub without them", async () => {
  withHub({}, [], null);
  const { unmount } = render(<Accounts engine={claude} />);
  await act(async () => {});
  expect(screen.getByText("This Desk keeps no accounts yet: update Desk to add them.")).toBeTruthy();
  unmount();
  withHub({ accounts: vi.fn(async () => null) });
  render(<Accounts engine={claude} />);
  await act(async () => {});
  expect(screen.queryByText("Accounts")).toBeNull();
});

it("switches automatically only once the person turns it on", async () => {
  const setAutoSwitch = vi.fn(async () => undefined);
  withHub({ setAutoSwitch }, [account("a-w", "Work", { isDefault: true })]);
  render(<Accounts engine={claude} />);
  await act(async () => {});
  const toggle = screen.getByRole("switch", { name: /Switch automatically when an account hits its limit/ });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await act(async () => fireEvent.click(toggle));
  expect(setAutoSwitch).toHaveBeenCalledWith(true);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

it("says when a sign-in can't be used, in plain words, until the person says OK", async () => {
  const dismissSignInProblem = vi.fn(async () => undefined);
  const full = withHub({ dismissSignInProblem }, [account("a-p", "Personal", { signedIn: false })]);
  full.accounts = vi.fn(async () => ({
    accounts: [account("a-p", "Personal", { signedIn: false })],
    store: "the keychain",
    signIns: [],
    problems: [{ account: "a-p", name: "Personal", problem: "unreadable" as const }],
  }));
  render(<Accounts engine={claude} />);
  await act(async () => {});
  expect(screen.getByText(/Desk couldn’t read Personal’s sign-in from the keychain just now, so nothing was switched/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  expect(dismissSignInProblem).toHaveBeenCalledWith("a-p");
});

it("says which account this computer's sign-in is, how Desk knows, and lets the person change it", async () => {
  const setOwnSignIn = vi.fn(async () => undefined);
  const gmail = account("a-g", "Kingsley Gmail", { identity: { key: "k-gmail", email: "sam@example.com", linkedBy: "usage", thisComputer: true } });
  const work = account("a-w", "Work");
  withHub({ setOwnSignIn }, [gmail, work]);
  render(<Accounts engine={claude} />);
  await act(async () => {});
  expect(screen.getByText(/This computer’s Claude Code sign-in is/).textContent).toContain("Kingsley Gmail");
  expect(screen.getByText(/\(matched by its usage\) · sam@example.com/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  await act(async () => fireEvent.change(screen.getByRole("combobox"), { target: { value: "a-w" } }));
  expect(setOwnSignIn).toHaveBeenCalledWith("a-w");
});

it("asks which account an unmatched sign-in is, and takes none of them", async () => {
  const setOwnSignIn = vi.fn(async () => undefined);
  withHub({ setOwnSignIn }, [account("a-w", "Work")]);
  render(<Accounts engine={claude} />);
  await act(async () => {});
  expect(screen.getByText(/This computer’s Claude Code is signed in as sam@example.com/)).toBeTruthy();
  await act(async () => fireEvent.change(screen.getByRole("combobox"), { target: { value: "none" } }));
  expect(setOwnSignIn).toHaveBeenCalledWith(null);
});
