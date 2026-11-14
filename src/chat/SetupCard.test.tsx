import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HubError } from "../hub/client";
import type { ConnectionsApi, Setup, SetupNow } from "../hub/connections";
import { useUi } from "../shell/ui";
import { SETUP_LIFE_MS, SIGN_IN_ESCAPE_MS, SetupCards, setupsSince, setupsStarted } from "./SetupCard";
import { useChat } from "./store";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
const opened: string[] = [];
vi.mock("../platform", async (real) => ({ ...(await real<object>()), openUrl: (u: string) => opened.push(u) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  opened.length = 0;
});

const ORIGIN = { hub: "local", agent: "desk" };

const now = (n: Partial<SetupNow>): SetupNow => ({
  kind: "working",
  title: "Setting up GitHub for Allan",
  detail: null,
  code: null,
  url: null,
  expiresAt: null,
  action: null,
  other: null,
  ...n,
});

const setup = (s: Partial<Setup> = {}): Setup => ({
  id: "s1",
  agent: "desk",
  session: null,
  service: "github",
  serviceName: "GitHub",
  name: "GitHub",
  site: null,
  startedAt: "2026-11-11T11:04:10Z",
  askedAt: "2026-11-11T11:04:10Z",
  steps: [
    { id: "sign_in", label: "Approve Desk on GitHub", state: "waiting", note: null },
    { id: "check", label: "Check it works, then turn it on for Allan", state: "todo", note: null },
  ],
  connected: null,
  way: "device",
  now: now({}),
  ended: null,
  write: false,
  forWhom: "Allan",
  ...s,
});

const OFFER = now({
  kind: "offer",
  title: "GitHub is signed in on this Mac as sarah",
  detail: "Through GitHub CLI. Allan gets the same access (repo, read:org), read only. Desk keeps a copy in the vault on this computer.",
  action: "use_cli",
  other: "other_way",
});
const CODE = now({
  kind: "code",
  title: "Enter this code on GitHub",
  detail: "Desk carries on as soon as you approve it on GitHub.",
  code: "ABCD-1234",
  url: "https://github.com/login/device",
  expiresAt: new Date(Date.now() + 14 * 60_000).toISOString(),
  action: "open_code",
});
const CONNECTED = now({
  kind: "connected",
  title: "GitHub connected as sarah",
  detail: "Allan uses it · read only · kept in the vault on this computer",
});

const api = (setups: Setup[], over: Partial<ConnectionsApi> = {}): ConnectionsApi =>
  ({
    setups: vi.fn(async () => setups),
    signedIn: vi.fn(async () => setups[0]),
    choose: vi.fn(async () => setups[0]),
    pasteToken: vi.fn(async () => setups[0]),
    ...over,
  }) as unknown as ConnectionsApi;

let shown: string[] = [];
let onScreen = true;
const card = (a: ConnectionsApi, count = 1, since = "2026-11-11T11:04:00Z", until?: string) => (
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
  />
);
const show = async (a: ConnectionsApi, count = 1, since = "2026-11-11T11:04:00Z", until?: string) => {
  shown = [];
  render(card(a, count, since, until));
  await act(async () => {});
};

it("is one card saying the one thing to do now: use the sign-in on this Mac", async () => {
  const a = api([setup({ way: "cli", now: OFFER })], { choose: vi.fn(async () => setup({ now: CONNECTED })) });
  await show(a);
  const region = screen.getByRole("region", { name: "Setting up GitHub · GitHub" });
  expect(region.className).toContain("setup-needs");
  expect(screen.getByText("GitHub is signed in on this Mac as sarah")).toBeTruthy();
  expect(screen.getByText(/repo, read:org/)).toBeTruthy();
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Use it", "Sign in another way"]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
  });
  expect(a.choose).toHaveBeenCalledWith("s1", "use-cli");
  // The same card, now saying what came of it, with nothing left to press
  // but a quiet way to Connections.
  expect(screen.getByText("GitHub connected as sarah")).toBeTruthy();
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Open in Connections"]);
  expect(screen.getAllByRole("region")).toHaveLength(1);
});

it("shows GitHub's code, copies it and opens GitHub in one press", async () => {
  const wrote: string[] = [];
  Object.assign(navigator, { clipboard: { writeText: async (t: string) => void wrote.push(t) } });
  await show(api([setup({ now: CODE })]));
  expect(screen.getByText("ABCD-1234")).toBeTruthy();
  expect(screen.getByText(/The code expires in 14 min/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy code and open GitHub" }));
  });
  expect(wrote).toEqual(["ABCD-1234"]);
  expect(opened).toEqual(["https://github.com/login/device"]);
  expect(screen.getByRole("button", { name: "Copied · open GitHub again" })).toBeTruthy();
});

it("asks for a new code in place when one didn't connect", async () => {
  const failed = setup({
    now: now({ kind: "failed", title: "GitHub didn't connect", detail: "The code expired before it was approved. Nothing was kept.", action: "new_code" }),
  });
  const a = api([failed], { choose: vi.fn(async () => setup({ now: CODE })) });
  await show(a);
  expect(screen.getByText(/Nothing was kept/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Get a new code" }));
  });
  expect(a.choose).toHaveBeenCalledWith("s1", "new-code");
  expect(screen.getByText("ABCD-1234")).toBeTruthy();
});

it("asks the agent to try again where a key it made didn't work", async () => {
  const sent: [string, string][] = [];
  useChat.setState({ send: (key: string, content: string) => (sent.push([key, content]), true) } as never);
  const failed = setup({ way: "browser", now: now({ kind: "failed", title: "GitHub didn't connect", detail: "GitHub didn't accept the key. Nothing was kept.", action: "retry" }) });
  await show(api([failed]));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  expect(sent).toEqual([["local/desk", "Please try setting up GitHub again."]]);
});

it("asks the person to sign in in Desk's window, with no 'I'm signed in' button until Desk hasn't seen it for a while", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-11-11T11:05:00Z") });
  const signIn = setup({
    way: "browser",
    now: now({ kind: "sign_in", title: "Sign in to GitHub in Desk's window", detail: "Your password stays with you: Desk never reads or types it. It carries on by itself once you're in.", action: "show_page" }),
  });
  const sent: string[] = [];
  useChat.setState({ send: (_k: string, c: string) => (sent.push(c), true) } as never);
  const a = api([signIn]);
  await show(a);
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Show the page"]);
  useUi.setState({ settings: null });
  onScreen = false;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Show the page" }));
  });
  expect(shown).toEqual(["desk"]);
  expect(useUi.getState().settings).toBe("browser");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SIGN_IN_ESCAPE_MS + 16_000);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Already signed in?" }));
  });
  expect(a.signedIn).toHaveBeenCalledWith("s1");
  expect(sent).toEqual(["I’m signed in."]);
  onScreen = true;
});

it("says a setup has ended only when the hub says so; otherwise that Desk wasn't reached", async () => {
  await show(api([setup({ way: "cli", now: OFFER })], { choose: vi.fn(async () => Promise.reject(new HubError(404, "That setup has ended."))) }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
  });
  expect(screen.getByRole("alert").textContent).toBe("That setup has ended. Ask again to start over.");
  cleanup();

  await show(api([setup({ way: "cli", now: OFFER })], { choose: vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))) }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
  });
  expect(screen.getByRole("alert").textContent).toMatch(/Desk couldn’t be reached just now/);
  expect((screen.getByRole("button", { name: "Use it" }) as HTMLButtonElement).disabled).toBe(false);
});

it("stops asking once it is connected", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const a = api([setup({ now: CONNECTED, connected: { connection: "agent~allan~github", account: "sarah", onFor: "Allan", write: false } })]);
  await show(a);
  expect(screen.getByText("GitHub connected as sarah")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/~/);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(a.setups).toHaveBeenCalledTimes(1);
});

it("never shows a setup a newer one replaced", async () => {
  await show(api([setup({ ended: "replaced", now: now({ kind: "ended", title: "This GitHub setup was replaced" }) })]));
  expect(screen.queryByRole("region")).toBeNull();
});

it("shows a setup asked for again on the newest message that asked, and only there", async () => {
  // Started at 11:04:10 by the first message, asked for again at 11:20.
  const again = setup({ askedAt: "2026-11-11T11:20:00Z" });
  const a = api([again]);
  render(
    <>
      {card(a, 1, "2026-11-11T11:04:00Z", "2026-11-11T11:25:00Z")}
      <div data-testid="newer">{card(a, 1, "2026-11-11T11:19:50Z")}</div>
    </>,
  );
  await act(async () => {});
  expect(screen.getAllByRole("region")).toHaveLength(1);
  expect(screen.getByTestId("newer").querySelector("section")).toBeTruthy();
});

it("shows only the setups the message started", async () => {
  await show(api([setup({ id: "old", name: "Old", startedAt: "2026-11-11T10:00:00Z", askedAt: "2026-11-11T10:00:00Z" }), setup()]));
  expect(screen.queryByRole("region", { name: "Setting up GitHub · Old" })).toBeNull();
  expect(screen.getByRole("region", { name: "Setting up GitHub · GitHub" })).toBeTruthy();
});

it("counts the setups a turn started", () => {
  expect(setupsStarted([{ tool: "connections.setup" }, { tool: "browser.navigate" }, { name: "connections.setup" }])).toBe(2);
  expect(setupsStarted(undefined)).toBe(0);
});

it("finds a kept message's setups from the message before it, not its own time, which is its turn's end", () => {
  const kept = { at: "2026-11-11T11:30:00Z", tools: [] };
  expect(setupsSince(kept, "2026-11-11T11:04:00Z")).toBe("2026-11-11T11:04:00Z");
  const live = { at: "2026-11-11T11:04:00Z", tools: [{ name: "connections.setup", startedAt: Date.parse("2026-11-11T11:06:00Z") }] };
  expect(setupsSince(live, "2026-11-11T11:03:00Z")).toBe("2026-11-11T11:06:00.000Z");
  expect(Date.parse(setupsSince(kept))).toBe(Date.parse(kept.at) - SETUP_LIFE_MS);
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
  const a = api([setup({ now: CODE })]);
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
  expect((failing.setups as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(6);
  cleanup();

  const old = api([], { setups: vi.fn(async () => Promise.reject(new HubError(404, "no route"))) });
  await show(old, 1, "2026-11-11T11:04:55Z");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(old.setups).toHaveBeenCalledTimes(1);
});

const PAGE = "https://github.com/settings/personal-access-tokens/new?name=Desk&contents=read";

it("offers a token of the person's own beside the primary action, pasted on the card and never into the chat", async () => {
  const sent: string[] = [];
  useChat.setState({ send: (_k: string, c: string) => (sent.push(c), true) } as never);
  const a = api([setup({ now: { ...CODE, paste: PAGE } })], {
    pasteToken: vi.fn(async () => setup({ way: "browser", now: CONNECTED })),
  });
  await show(a);
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Copy code and open GitHub", "Paste a token"]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Paste a token" }));
  });
  expect(opened).toEqual([PAGE]);
  const field = screen.getByLabelText(/choose All repositories/) as HTMLInputElement;
  expect(field.type).toBe("password");
  expect(field.autocomplete).toBe("off");
  fireEvent.change(field, { target: { value: " github_pat_secretvalue " } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  });
  expect(a.pasteToken).toHaveBeenCalledWith("s1", "github_pat_secretvalue");
  expect(sent).toEqual([]);
  expect(screen.getByText("GitHub connected as sarah")).toBeTruthy();
  expect(screen.queryByLabelText(/Paste the token here/)).toBeNull();
  expect(document.body.innerHTML).not.toContain("github_pat_secretvalue");
});

it("says what was wrong with a pasted token, and keeps nothing of it on screen", async () => {
  const a = api([setup({ way: "cli", now: { ...OFFER, paste: PAGE } })], {
    pasteToken: vi.fn(async () => Promise.reject(new HubError(400, "That doesn't look like a GitHub token: it starts github_pat_ or ghp_."))),
  });
  await show(a);
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Use it", "Paste a token", "Sign in another way"]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Paste a token" }));
  });
  fireEvent.change(screen.getByLabelText(/Paste the token here/), { target: { value: "hunter2" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  });
  expect(screen.getByRole("alert").textContent).toMatch(/doesn't look like a GitHub token/);
  expect((screen.getByLabelText(/Paste the token here/) as HTMLInputElement).value).toBe("");
});
