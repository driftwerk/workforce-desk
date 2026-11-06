// The machine sign-in as the app renders it in development: inside React's
// StrictMode, which mounts, unmounts and mounts again. A sign-in begun there
// once stayed on "Opening Claude's sign-in page…" for good, because the
// flag saying the card was still there was cleared on the first unmount
// and never set again, and every answer from the machine was dropped.

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import type { DeskTransport } from "../hub/transport";
import type { AccountSignIn, AccountsInfo } from "../hub/types";
import { SIGN_IN_POLL_MS, SignInOn } from "./SignIn";
import { fakeNative, noEngines, withEngine } from "./testing";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("../platform", () => ({
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  machinePluginDir: vi.fn(async () => null),
  inApp: false,
  openUrl: vi.fn(),
}));

const PAGE = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A45678%2Fcallback&state=s";

beforeEach(() => noEngines());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function engine() {
  const state: { accounts: AccountsInfo } = { accounts: { accounts: [], store: "Desk's private file", signIns: [] } };
  const hub = {
    accounts: vi.fn(async () => state.accounts),
    engines: vi.fn(async () => [
      { engine: "claude", title: "Claude Code", installed: true, signIn: { state: "out" } },
      { engine: "codex", title: "Codex", installed: true, signIn: { state: "out" } },
    ]),
    addAccount: vi.fn(async (): Promise<unknown> => ({ kind: "signIn", signIn: { id: "si-1", engine: "claude", name: "Claude", state: "starting" } })),
    cancelSignIn: vi.fn(async () => {}),
  };
  const run = (s: Partial<AccountSignIn>) => {
    state.accounts = { ...state.accounts, signIns: [{ id: "si-1", engine: "claude", name: "Claude", state: "starting", ...s } as AccountSignIn] };
  };
  return { hub, run };
}

it("leaves 'Opening Claude's sign-in page…' under StrictMode once the machine has its page: the forward starts and the page opens", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = engine();
  const n = fakeNative();
  withEngine("devbox", e.hub as unknown as DeskHub);
  render(
    <StrictMode>
      <SignInOn machine="devbox" name="devbox" native={n.native} />
    </StrictMode>,
  );
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude" })));
  expect(screen.getByText("Opening Claude’s sign-in page…")).toBeTruthy();

  // What the machine's hub said on devbox: a code page, and the page that
  // comes back by itself ready.
  e.run({ state: "code", url: PAGE, directReady: true });
  await act(async () => void (await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS)));
  expect(n.fake.signInForward).toHaveBeenCalledWith("devbox", "si-1");
  expect(screen.queryByText("Opening Claude’s sign-in page…")).toBeNull();
  expect(screen.getByText(/Finish signing in in your browser/)).toBeTruthy();
});

it("signs ChatGPT in under StrictMode too: the device page opens and its code shows", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const e = engine();
  const transport: DeskTransport = {
    fetch: async (method, path) => {
      if (method === "POST" && path === "/api/desk/engines/sign-ins")
        return Response.json({ id: "cx-1", engine: "codex", state: "device", url: "https://auth.openai.com/codex/device", code: "K7QF-2M9D" }, { status: 202 });
      return new Response(null, { status: 404 });
    },
    socket: () => {
      throw new Error("no sockets here");
    },
  };
  const n = fakeNative();
  n.fake.transport.mockReturnValue(transport);
  withEngine("devbox", e.hub as unknown as DeskHub);
  render(
    <StrictMode>
      <SignInOn machine="devbox" name="devbox" native={n.native} />
    </StrictMode>,
  );
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in to ChatGPT" })));
  await act(async () => {});
  expect(n.fake.openSignInPage).toHaveBeenCalledWith("codex", "https://auth.openai.com/codex/device");
  expect(screen.getByText("K7QF-2M9D")).toBeTruthy();
});
