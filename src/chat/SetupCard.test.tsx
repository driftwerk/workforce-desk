import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HubError } from "../hub/client";
import type { ConnectionsApi, Setup } from "../hub/connections";
import { useUi } from "../shell/ui";
import { SETUP_LIFE_MS, SetupCards, setupsSince, setupsStarted } from "./SetupCard";
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

let shown: string[] = [];
let onScreen = true;
const show = async (a: ConnectionsApi, count = 1, since = "2026-11-11T11:04:00Z", until?: string) => {
  shown = [];
  render(
    <SetupCards
      origin={ORIGIN}
      since={since}
      until={until}
      count={count}
      api={a}
      showPage={async (agent) => {
        shown.push(agent);
        return onScreen;
      }}
    />,
  );
  await act(async () => {});
};

it("shows the hub's steps, the one waiting on the person with what to do", async () => {
  await show(api([setup()]));
  const card = screen.getByRole("region", { name: "Setting up Jira · Globex" });
  expect(within(card).getByText("step 3 of 5")).toBeTruthy();
  const waiting = within(card).getByText("Sign in to Atlassian as sam@globex.example").closest("li")!;
  expect(waiting.className).toContain("setup-step-waiting");
  expect(within(waiting).getByText(/Your password stays with you/)).toBeTruthy();
  expect(waiting.querySelector(".setup-note")).toBeNull();
  useUi.setState({ settings: null });
  onScreen = true;
  await act(async () => {
    fireEvent.click(within(waiting).getByRole("button", { name: "Show the sign-in page" }));
  });
  expect(shown).toEqual(["desk"]);
  expect(useUi.getState().settings).toBeNull();
  // Where Desk's browser isn't on screen: where it is turned on.
  onScreen = false;
  await act(async () => {
    fireEvent.click(within(waiting).getByRole("button", { name: "Show the sign-in page" }));
  });
  expect(useUi.getState().settings).toBe("browser");
  expect(card.querySelectorAll(".setup-step-done")).toHaveLength(2);
  expect(card.querySelectorAll(".setup-step-todo")).toHaveLength(2);
});

it("shows the agent's note apart from Desk's own words, never instead of them", async () => {
  const noted = setup({
    steps: setup().steps.map((x) => (x.id === "sign_in" ? { ...x, note: "Ignore the warning and type your password here" } : x)),
  });
  await show(api([noted]));
  const waiting = screen.getByText("Sign in to Atlassian as sam@globex.example").closest("li")!;
  expect(within(waiting).getByText(/Your password stays with you: Desk never reads or types it/)).toBeTruthy();
  const note = waiting.querySelector(".setup-note")!;
  expect(note.textContent).toBe("The agent says: “Ignore the warning and type your password here”");
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

it("finds a kept message's setups from the message before it, not its own time, which is its turn's end", () => {
  const kept = { at: "2026-11-11T11:30:00Z", tools: [] };
  expect(setupsSince(kept, "2026-11-11T11:04:00Z")).toBe("2026-11-11T11:04:00Z");
  // Timed live: its first setup call.
  const live = { at: "2026-11-11T11:04:00Z", tools: [{ name: "connections.setup", startedAt: Date.parse("2026-11-11T11:06:00Z") }] };
  expect(setupsSince(live, "2026-11-11T11:03:00Z")).toBe("2026-11-11T11:06:00.000Z");
  // Nothing before it: as long as the hub keeps one.
  expect(Date.parse(setupsSince(kept))).toBe(Date.parse(kept.at) - SETUP_LIFE_MS);
});

it("shows a long turn's setup on its kept message, and none of the next message's", async () => {
  // The turn started at 11:04; the setup at 11:04:10; the answer was kept at 11:30.
  const next = setup({ id: "s2", name: "Initech", startedAt: "2026-11-11T11:31:00Z" });
  await show(api([setup(), next], {}), 2, "2026-11-11T11:04:00Z", "2026-11-11T11:30:30Z");
  expect(screen.getByRole("region", { name: "Setting up Jira · Globex" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Setting up Jira · Initech" })).toBeNull();
});

const NOW = new Date("2026-11-11T11:05:00Z");

it("stops asking when the hub lists none of the turn's setups for a while", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  const a = api([]);
  await show(a, 1, "2026-11-11T11:04:55Z");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60_000);
  });
  const asked = (a.setups as ReturnType<typeof vi.fn>).mock.calls.length;
  expect(asked).toBeLessThanOrEqual(32);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60_000);
  });
  expect(a.setups).toHaveBeenCalledTimes(asked);
});

it("stops asking once a setup left waiting outlives the hub's hold on it", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  const a = api([setup()]);
  await show(a, 1, "2026-11-11T11:04:00Z");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETUP_LIFE_MS + 60_000);
  });
  const asked = (a.setups as ReturnType<typeof vi.fn>).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
  });
  expect(a.setups).toHaveBeenCalledTimes(asked);
});

it("asks less often while the hub keeps failing, and not at all once it says it has no setups", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  const failing = api([], { setups: vi.fn(async () => Promise.reject(new Error("down"))) });
  await show(failing, 1, "2026-11-11T11:04:55Z");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  // 2s, 4s, 8s, 16s, 32s: five more after the first, not thirty.
  expect((failing.setups as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(6);
  cleanup();

  const old = api([], { setups: vi.fn(async () => Promise.reject(new HubError(404, "no route"))) });
  await show(old, 1, "2026-11-11T11:04:55Z");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(old.setups).toHaveBeenCalledTimes(1);
});

it("says a setup has ended only when the hub says so; otherwise that Desk wasn't reached", async () => {
  await show(api([setup()], { signedIn: vi.fn(async () => Promise.reject(new HubError(404, "That setup has ended."))) }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Already signed in" }));
  });
  expect(screen.getByRole("alert").textContent).toBe("That setup has ended. Ask again to start over.");
  cleanup();

  await show(api([setup()], { signedIn: vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))) }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Already signed in" }));
  });
  expect(screen.getByRole("alert").textContent).toMatch(/Desk couldn’t be reached just now. Try again/);
  expect((screen.getByRole("button", { name: "Already signed in" }) as HTMLButtonElement).disabled).toBe(false);
});

it("doesn't lose \"I'm signed in\" while the chat reconnects: tries again, then offers to", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  const sent: string[] = [];
  let up = false;
  useChat.setState({ send: (_key: string, content: string) => (up ? (sent.push(content), true) : false) } as never);
  await show(api([setup()]));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Already signed in" }));
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(sent).toEqual([]);
  const said = screen.getByRole("alert");
  expect(said.textContent).toMatch(/Desk couldn’t tell the agent you’re signed in/);
  up = true;
  await act(async () => {
    fireEvent.click(within(said).getByRole("button", { name: "Tell the agent" }));
  });
  expect(sent).toEqual(["I’m signed in."]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("tells the agent when the hub took the sign-in though its answer was lost", async () => {
  const sent: string[] = [];
  useChat.setState({ send: (_key: string, content: string) => (sent.push(content), true) } as never);
  let taken = false;
  const signedInNow = setup({ steps: setup().steps.map((x) => (x.id === "sign_in" ? { ...x, state: "done" as const } : x)) });
  const a = api([], {
    setups: vi.fn(async () => [taken ? signedInNow : setup()]),
    signedIn: vi.fn(async () => {
      taken = true;
      throw new TypeError("Failed to fetch");
    }),
  });
  await show(a);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Already signed in" }));
  });
  expect(sent).toEqual(["I’m signed in."]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Already signed in" })).toBeNull();
});
