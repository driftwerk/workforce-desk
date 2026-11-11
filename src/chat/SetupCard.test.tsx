import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionsApi, Setup } from "../hub/connections";
import { useUi } from "../shell/ui";
import { SetupCards, setupsStarted } from "./SetupCard";
import { useChat } from "./store";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ORIGIN = { hub: "local", agent: "desk" };

const setup = (s: Partial<Setup> = {}): Setup => ({
  id: "s1",
  agent: "desk",
  session: null,
  service: "jira",
  serviceName: "Jira",
  name: "Globex",
  site: "globex.atlassian.net",
  startedAt: "2026-11-11T11:04:10Z",
  steps: [
    { id: "where", label: "Found your site: globex.atlassian.net", state: "done", note: null },
    { id: "page", label: "Open id.atlassian.com › Security › API tokens", state: "done", note: null },
    { id: "sign_in", label: "Sign in to Atlassian as sam@globex.example", state: "waiting", note: null },
    { id: "key", label: "Make an API token and save it to the vault", state: "todo", note: null },
    { id: "check", label: "Check it works, then turn it on for Lattice", state: "todo", note: null },
  ],
  connected: null,
  ...s,
});

const api = (setups: Setup[], over: Partial<ConnectionsApi> = {}): ConnectionsApi =>
  ({
    setups: vi.fn(async () => setups),
    signedIn: vi.fn(async () => setup({ steps: setup().steps.map((x) => (x.id === "sign_in" ? { ...x, state: "done" as const } : x)) })),
    ...over,
  }) as unknown as ConnectionsApi;

const show = async (a: ConnectionsApi, count = 1) => {
  render(<SetupCards origin={ORIGIN} at="2026-11-11T11:04:00Z" count={count} api={a} />);
  await act(async () => {});
};

it("shows the hub's steps, the one waiting on the person with what to do", async () => {
  await show(api([setup()]));
  const card = screen.getByRole("region", { name: "Setting up Jira · Globex" });
  expect(within(card).getByText("step 3 of 5")).toBeTruthy();
  const waiting = within(card).getByText("Sign in to Atlassian as sam@globex.example").closest("li")!;
  expect(waiting.className).toContain("setup-step-waiting");
  expect(within(waiting).getByText(/Your password stays with you/)).toBeTruthy();
  fireEvent.click(within(waiting).getByRole("button", { name: "Show the sign-in page" }));
  expect(useUi.getState().settings).toBe("browser");
  expect(card.querySelectorAll(".setup-step-done")).toHaveLength(2);
  expect(card.querySelectorAll(".setup-step-todo")).toHaveLength(2);
});

it("tells the hub and the agent the person is signed in", async () => {
  const sent: [string, string][] = [];
  useChat.setState({ send: (key: string, content: string) => (sent.push([key, content]), true) } as never);
  const a = api([setup()]);
  await show(a);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Already signed in" }));
  });
  expect(a.signedIn).toHaveBeenCalledWith("s1");
  expect(sent).toEqual([["local/desk", "I’m signed in."]]);
  expect(screen.queryByRole("button", { name: "Already signed in" })).toBeNull();
});

it("says what is connected, for whom, once it is on, and stops asking", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const done = setup({
    steps: setup().steps.map((x) => ({ ...x, state: "done" as const })),
    connected: { connection: "agent~lattice~globex", account: "sam@globex.example", onFor: "Lattice", write: true },
  });
  const a = api([done]);
  await show(a);
  const ok = screen.getByRole("region", { name: "Jira · Globex is connected" });
  expect(within(ok).getByText("Lattice uses it · read and write")).toBeTruthy();
  expect(within(ok).getByText(/Signed in as sam@globex.example/)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/~/);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(a.setups).toHaveBeenCalledTimes(1);
});

it("shows only the setups the message started", async () => {
  await show(api([setup({ id: "old", name: "Old", startedAt: "2026-11-11T10:00:00Z" }), setup()]));
  expect(screen.queryByRole("region", { name: "Setting up Jira · Old" })).toBeNull();
  expect(screen.getByRole("region", { name: "Setting up Jira · Globex" })).toBeTruthy();
});

it("counts the setups a turn started", () => {
  expect(setupsStarted([{ tool: "connections.setup" }, { tool: "browser.navigate" }, { name: "connections.setup" }])).toBe(2);
  expect(setupsStarted(undefined)).toBe(0);
});
