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
