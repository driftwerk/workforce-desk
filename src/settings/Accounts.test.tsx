import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAccounts } from "../engines/accounts";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { AccountSignIn, EngineAccount, EngineInfo } from "../hub/types";
import { Accounts } from "./Accounts";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
const opened = vi.fn();
vi.mock("../platform", () => ({ inApp: false, openUrl: (u: string) => opened(u) }));

beforeEach(() => useAccounts.setState({ accounts: [], store: null, signIns: {}, supported: null }));
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
  expect(screen.getByRole("button", { name: "Add account…" })).toBeTruthy();
});

it("lists each account, the default marked, its sessions, and one whose sign-in is gone", async () => {
  const updateAccount = vi.fn(async () => ({}));
  withHub({ updateAccount }, [account("a-w", "Work", { isDefault: true, sessions: ["s1", "s2"] }), account("a-p", "Personal", { signedIn: false })]);
  render(<Accounts engine={claude} />);
  await act(async () => {});
  expect(screen.getByText("Default")).toBeTruthy();
  expect(screen.getByText("2 sessions on it")).toBeTruthy();
  expect(screen.getByText("Its sign-in is gone: remove it and add it again")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make default" })));
  expect(updateAccount).toHaveBeenCalledWith("a-p", { isDefault: true });
});

it("adds an account from a pasted token, sent once and never shown", async () => {
  const addAccount = vi.fn(async () => ({ kind: "account", account: account("a-w", "Work") }));
  withHub({ addAccount });
  render(<Accounts engine={claude} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Add account…" }));
  fireEvent.change(screen.getByPlaceholderText("Work"), { target: { value: "Work" } });
  fireEvent.click(screen.getByRole("radio", { name: "Paste a token" }));
  const field = screen.getByLabelText("Token from claude setup-token") as HTMLInputElement;
  expect(field.type).toBe("password");
  fireEvent.change(field, { target: { value: "sk-ant-oat01-pasted" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add account" })));
  expect(addAccount).toHaveBeenCalledWith({ engine: "claude", name: "Work", token: "sk-ant-oat01-pasted", makeDefault: true });
  expect(screen.queryByLabelText("Token from claude setup-token")).toBeNull();
});

it("says why the hub refused an account", async () => {
  withHub({ addAccount: vi.fn(async () => Promise.reject(new Error("Claude Code didn't accept that token"))) });
  render(<Accounts engine={claude} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Add account…" }));
  fireEvent.change(screen.getByPlaceholderText("Work"), { target: { value: "Work" } });
  fireEvent.click(screen.getByRole("radio", { name: "Paste a token" }));
  fireEvent.change(screen.getByLabelText("Token from claude setup-token"), { target: { value: "bad" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add account" })));
  expect(screen.getByText(/didn't accept that token/)).toBeTruthy();
});

it("signs in through Claude's page: opening, a code, checking, done", async () => {
  const addAccount = vi.fn(async () => ({ kind: "signIn", signIn: signIn({ state: "starting" }) }));
  const signInCode = vi.fn(async () => signIn({ state: "code", url: null }));
  withHub({ addAccount, signInCode });
  render(<Accounts engine={claude} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Add account…" }));
  fireEvent.change(screen.getByPlaceholderText("Work"), { target: { value: "Personal" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in…" })));
  expect(screen.getByText("Opening Claude’s sign-in page…")).toBeTruthy();

  const move = (s: AccountSignIn) => act(async () => useAccounts.setState((st) => ({ signIns: { ...st.signIns, [s.id]: s } })));
  await move(signIn({ state: "open", url: "https://claude.ai/oauth/authorize?x=1" }));
  expect(screen.getByText("Finish signing in in your browser.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open the sign-in page again" }));
  expect(opened).toHaveBeenCalledWith("https://claude.ai/oauth/authorize?x=1");

  await move(signIn({ state: "code", url: null }));
  fireEvent.change(screen.getByPlaceholderText("Code from the page"), { target: { value: "c0de" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
  expect(signInCode).toHaveBeenCalledWith("i-1", "c0de");

  await move(signIn({ state: "checking" }));
  expect(screen.getByText("Checking the sign-in…")).toBeTruthy();
  await move(signIn({ state: "done", account: "a-p" }));
  expect(screen.getByText("Personal is added.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByRole("button", { name: "Add account…" })).toBeTruthy();
});

it("offers pasting a token when the sign-in fails, saying why", async () => {
  const addAccount = vi.fn(async () => ({ kind: "signIn", signIn: signIn({ state: "starting" }) }));
  withHub({ addAccount });
  render(<Accounts engine={claude} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Add account…" }));
  fireEvent.change(screen.getByPlaceholderText("Work"), { target: { value: "Personal" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in…" })));
  await act(async () =>
    useAccounts.setState({ signIns: { "i-1": signIn({ state: "failed", why: "Desk couldn't read the token from Claude Code: paste it instead" }) } }),
  );
  expect(screen.getByText(/paste it instead/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Paste a token instead" }));
  expect(screen.getByLabelText("Token from claude setup-token")).toBeTruthy();
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
  const toggle = screen.getByRole("checkbox", { name: /Switch automatically when an account hits its limit/ }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  await act(async () => fireEvent.click(toggle));
  expect(setAutoSwitch).toHaveBeenCalledWith(true);
  expect(toggle.checked).toBe(true);
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
