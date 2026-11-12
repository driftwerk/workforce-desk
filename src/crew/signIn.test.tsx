// A new crew member, and the Claude plan in Providers: each checks that what
// they think with can answer, and one Claude sign-in serves the crew and
// coding sessions both.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import type { Provider } from "../hub/providers";
import { useDesk } from "../hub/store";
import { useAccounts } from "../engines/accounts";
import { useProviders } from "../providers/store";
import { useSettings } from "../settings/store";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
const startLogin = vi.hoisted(() => vi.fn(async (_plan: string, _to?: unknown) => {}));
const progress = vi.hoisted(() => ({ f: null as null | ((plan: string, p: unknown) => void) }));
vi.mock("../platform", () => ({
  inApp: false,
  openUrl: vi.fn(),
  startLogin: (plan: string, to?: unknown) => startLogin(plan, to),
  cliInstalled: vi.fn(async () => true),
  installCli: vi.fn(async () => {}),
  cancelLogin: vi.fn(async () => {}),
  sendLoginCode: vi.fn(async () => {}),
  onLoginProgress: vi.fn(async (f: (plan: string, p: unknown) => void) => {
    progress.f = f;
    return () => {};
  }),
  onInstallProgress: vi.fn(async () => () => {}),
  subscribe: (p: Promise<() => void>) => () => void p.then((f) => f()),
  listen: vi.fn(async () => () => {}),
  machinesList: vi.fn(async () => []),
  onMachinesChanged: vi.fn(async () => () => {}),
  saveSettings: vi.fn(async () => {}),
}));

const { NewCrew } = await import("./NewCrew");
const { Providers } = await import("../settings/Providers");

const plan = (id: string, name: string, connected: boolean): Provider =>
  ({
    id,
    name,
    group: "plan",
    description: "",
    connected,
    connect: { kind: "login", fields: [] },
    models: [{ id: `${id}-mid`, name: "Mid", description: "", default: true }],
    efforts: [],
    defaultEffort: null,
  }) as unknown as Provider;

let providers: Provider[] = [];
beforeEach(() => {
  startLogin.mockClear();
  progress.f = null;
  providers = [plan("claude-code", "Claude plan", false), plan("chatgpt", "ChatGPT plan", false)];
  const hub = {
    providers: vi.fn(async () => providers),
    accounts: vi.fn(async () => ({ accounts: [], store: "the keychain", signIns: [] })),
  };
  useDesk.setState({ hub: hub as unknown as DeskHub, fail: vi.fn() });
  useProviders.setState({ providers: [], loaded: false, loading: false, fallback: false, problem: null });
  useAccounts.setState({ accounts: [], store: "the keychain", supported: true, signIns: {} });
  useSettings.setState({ newAgent: null });
});
afterEach(cleanup);

it("doesn't make a crew member who couldn't answer: says their plan isn't connected, signs it in there, then Create is on", async () => {
  render(<NewCrew onClose={() => {}} />);
  await act(async () => {});
  fireEvent.change(screen.getByPlaceholderText("Scout"), { target: { value: "Scout" } });
  fireEvent.change(screen.getByRole("textbox", { name: "What they’re for" }), { target: { value: "Watch CI" } });
  const fix = screen.getByRole("group", { name: "Claude plan isn’t connected" });
  expect(fix.textContent).toContain("Claude plan isn’t connected, so Scout couldn’t answer yet.");
  const create = screen.getByRole("button", { name: "Create Scout" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  await act(async () => fireEvent.click(within(fix).getByRole("button", { name: "Sign in to Claude" })));
  // One sign-in: the crew's plan, and an account for coding sessions while there's none.
  expect(startLogin).toHaveBeenCalledWith("claude", { agents: true, account: { name: "Claude", makeDefault: true } });
  providers = [plan("claude-code", "Claude plan", true), plan("chatgpt", "ChatGPT plan", false)];
  await act(async () => progress.f?.("claude", { state: "done", account: "a-1" }));
  await act(async () => {});
  expect(screen.queryByRole("group", { name: "Claude plan isn’t connected" })).toBeNull();
  expect((screen.getByRole("button", { name: "Create Scout" }) as HTMLButtonElement).disabled).toBe(false);
});

it("signs the Claude plan in once for the crew and coding sessions, unless the person says only the crew", async () => {
  render(<Providers />);
  await act(async () => {});
  const row = screen.getByText("Claude plan").closest(".prov-row") as HTMLElement;
  const also = within(row).getByRole("checkbox", { name: "Use this for coding sessions too" }) as HTMLInputElement;
  expect(also.checked).toBe(true);
  await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Connect" })));
  expect(startLogin).toHaveBeenLastCalledWith("claude", { agents: true, account: { name: "Claude", makeDefault: true } });
  fireEvent.click(also);
  await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Connect" })));
  expect(startLogin).toHaveBeenLastCalledWith("claude", { agents: true, account: null });
  // ChatGPT's sign-in is the agents' alone.
  const chatgpt = screen.getByText("ChatGPT plan").closest(".prov-row") as HTMLElement;
  expect(within(chatgpt).queryByRole("checkbox")).toBeNull();
});

it("closes once the crew member is made whole: their chat failing to open never offers to make them again", async () => {
  providers = [plan("claude-code", "Claude plan", true), plan("chatgpt", "ChatGPT plan", false)];
  const { useChat } = await import("../chat/store");
  const fail = vi.fn();
  const hub = {
    providers: vi.fn(async () => providers),
    accounts: vi.fn(async () => ({ accounts: [], store: "the keychain", signIns: [] })),
    createAgent: vi.fn(async () => {}),
    agentConfig: vi.fn(async () => ""),
    saveAgentConfig: vi.fn(async () => {}),
    identityFile: vi.fn(async () => "# x\n"),
    saveIdentityFile: vi.fn(async () => {}),
    deleteAgent: vi.fn(async () => {}),
  };
  useDesk.setState({ hub: hub as unknown as DeskHub, fail, openRoom: vi.fn(async () => Promise.reject(new Error("no room"))) as never });
  // The roster as the hub has it now: a scout made elsewhere since it was last read.
  const refreshRoster = vi.fn(async () => useChat.setState({ roster: [{ id: "scout", hubId: "local" }] as never }));
  useChat.setState({ roster: [], refreshRoster, openDm: vi.fn() });
  const onClose = vi.fn();
  render(<NewCrew onClose={onClose} />);
  await act(async () => {});
  fireEvent.change(screen.getByPlaceholderText("Scout"), { target: { value: "Scout" } });
  fireEvent.change(screen.getByRole("textbox", { name: "What they’re for" }), { target: { value: "Watch CI" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create Scout" })));
  expect(hub.createAgent).toHaveBeenCalledWith(expect.objectContaining({ id: "scout-2" }));
  expect(hub.deleteAgent).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
  expect(fail).toHaveBeenCalledWith(expect.any(Error), { what: "opening Scout’s chat" });
  expect(useDesk.getState().error?.plain ?? "").not.toContain("couldn’t finish");
});
