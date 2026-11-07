import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAccounts } from "../engines/accounts";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { AccountNeed } from "../hub/types";
import { AccountNeeds } from "./AccountNeeds";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

beforeEach(() => useAccounts.setState({ needs: [], leftInTerminals: [] }));
afterEach(cleanup);

const work = { id: "a-w", name: "Work" };
const personal = { id: "a-p", name: "Personal" };
const seven = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];

const withHub = (hub: Partial<Record<keyof DeskHub, unknown>>) => {
  const fail = vi.fn();
  useDesk.setState({ hub: hub as unknown as DeskHub, fail });
  return fail;
};

it("asks to switch every session off an account at its limit, and switches all", async () => {
  const switchAll = vi.fn(async () => ({ now: seven, afterTurn: [], nextStart: [], inTerminals: [] }));
  const putOffNeed = vi.fn(async () => undefined);
  withHub({ switchAll, putOffNeed });
  const need: AccountNeed = { kind: "limit", id: "limit:w:p", engine: "claude", from: work, to: personal, sessions: seven, resetsAt: null };
  useAccounts.setState({ needs: [need] });
  render(<AccountNeeds />);
  expect(screen.getByText("Work hit its limit — switch 7 sessions to Personal?")).toBeTruthy();
  expect(screen.getByText(/Desk never switches back by itself/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(putOffNeed).toHaveBeenCalledWith("limit:w:p");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch all" })));
  expect(switchAll).toHaveBeenCalledWith("a-w", "a-p");
});

it("says which sessions it couldn't move, as they run in terminals of their own", async () => {
  withHub({ switchAll: vi.fn(async () => ({ now: [], afterTurn: [], nextStart: [], inTerminals: ["t1", "t2"] })) });
  useAccounts.setState({ needs: [{ kind: "limit", id: "l", engine: "claude", from: work, to: { id: null, name: "this computer's sign-in" }, sessions: ["t1", "t2"], resetsAt: null }] });
  render(<AccountNeeds />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch all" })));
  await act(async () => useAccounts.setState({ needs: [] }));
  expect(screen.getByText("2 sessions run in a terminal of its own")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  expect(screen.queryByText(/terminal of its own/)).toBeNull();
});

it("says when every account is at its limit, with each reset, and offers no switch", () => {
  withHub({});
  useAccounts.setState({
    needs: [{ kind: "allFull", id: "all-full", engine: "claude", resets: [[work, "2026-11-07T09:00:00Z"], [personal, null]] }],
  });
  render(<AccountNeeds />);
  expect(screen.getByText("Every Claude account is at its limit")).toBeTruthy();
  expect(screen.getByText(/Personal: no reset time yet/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Switch all" })).toBeNull();
});

it("asks back once the account has reset, and switches back only when asked", async () => {
  const switchAll = vi.fn(async () => ({ now: seven, afterTurn: [], nextStart: [], inTerminals: [] }));
  withHub({ switchAll });
  useAccounts.setState({ needs: [{ kind: "reset", id: "reset:w:p", engine: "claude", account: work, from: personal, sessions: seven }] });
  render(<AccountNeeds />);
  expect(screen.getByText("Work has reset — switch 7 sessions back from Personal?")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch back" })));
  expect(switchAll).toHaveBeenCalledWith("a-p", "a-w");
});

it("shows nothing when no account needs the person", () => {
  withHub({});
  const { container } = render(<AccountNeeds />);
  expect(container.textContent).toBe("");
});

it("says why an account's sign-in can't be used, and OK clears it", async () => {
  const dismissSignInProblem = vi.fn(async () => undefined);
  withHub({ dismissSignInProblem });
  useAccounts.setState({ store: "the keychain", needs: [{ kind: "signIn", id: "sign-in:p", engine: "claude", account: personal, problem: "unreadable" }] });
  render(<AccountNeeds />);
  expect(screen.getByText("Personal’s sign-in can’t be used")).toBeTruthy();
  expect(screen.getByText(/so nothing was switched/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Switch all" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  expect(dismissSignInProblem).toHaveBeenCalledWith("a-p");
});

it("shows a need once, however often it came", () => {
  withHub({});
  const reset: AccountNeed = { kind: "reset", id: "reset:w:p", engine: "claude", account: work, from: personal, sessions: ["s1"] };
  useAccounts.setState({ needs: [reset, reset, reset, reset, reset] });
  render(<AccountNeeds />);
  expect(screen.getAllByText("Work has reset — switch 1 session back from Personal?")).toHaveLength(1);
});

it("asks which account this computer is signed in to, and keeps the answer", async () => {
  const setOwnSignIn = vi.fn(async () => undefined);
  const putOffNeed = vi.fn(async () => undefined);
  withHub({ setOwnSignIn, putOffNeed });
  useAccounts.setState({
    accounts: [
      { id: "a-w", engine: "claude", name: "Work", isDefault: true, signedIn: true, sessions: [], createdAt: "2026-11-01T00:00:00Z" },
      { id: "a-p", engine: "claude", name: "Personal", isDefault: false, signedIn: true, sessions: [], createdAt: "2026-11-02T00:00:00Z" },
    ],
    needs: [{ kind: "whichSignIn", id: "which-sign-in", engine: "claude", email: "kim@example.com" }],
  });
  render(<AccountNeeds />);
  expect(screen.getByText("Which of your accounts is this computer signed in to?")).toBeTruthy();
  expect(screen.getByText(/signed in as kim@example.com/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Personal" })));
  expect(setOwnSignIn).toHaveBeenCalledWith("a-p");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "None of these" })));
  expect(setOwnSignIn).toHaveBeenCalledWith(null);
  // Always dismissable.
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(putOffNeed).toHaveBeenCalledWith("which-sign-in");
});

it("says a session in a terminal of its own sits on a full plan, and what to do there", () => {
  const putOffNeed = vi.fn(async () => undefined);
  withHub({ putOffNeed });
  useAccounts.setState({
    needs: [{ kind: "inTerminal", id: "terminal:x", engine: "claude", session: "x", name: "api-fix", account: work, resetsAt: null }],
  });
  render(<AccountNeeds />);
  expect(screen.getByText("api-fix is at Work’s limit in a terminal of its own")).toBeTruthy();
  expect(screen.getByText(/run \/login there to use another account, or start it in Desk/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(putOffNeed).toHaveBeenCalledWith("terminal:x");
});
