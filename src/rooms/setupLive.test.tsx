import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyConversation, reduce, type ConversationState } from "../chat/conversation";
import { SetupCards } from "../chat/SetupCard";
import { Dock } from "../chat/SetupDock";
import { useChat } from "../chat/store";
import type { ChatMessage, ServerMessage } from "../chat/types";
import type { ConnectionsApi, Setup } from "../hub/connections";
import { useDesk } from "../hub/store";
import { Rooms } from "./Rooms";

vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));

// The setups this computer's hub keeps: GitHub's, which its CLI is signed in to.
const setups: Setup[] = [];
const api = {
  setups: vi.fn(async () => setups),
  choose: vi.fn(),
  signedIn: vi.fn(),
  pasteToken: vi.fn(),
} as unknown as ConnectionsApi;
vi.mock("../hub/connections", async (real) => ({ ...(await real<object>()), connectionsOf: () => api }));

Element.prototype.scrollIntoView = () => {};

const GITHUB = (startedAt: string): Setup => ({
  id: "0123456789abcdef0123456789abcdef",
  agent: "desk",
  session: "s1",
  service: "github",
  serviceName: "GitHub",
  name: "GitHub",
  site: null,
  startedAt,
  askedAt: startedAt,
  steps: [
    { id: "sign_in", label: "Use GitHub’s sign-in on this computer", state: "waiting", note: null },
    { id: "check", label: "Check it works, then turn it on for Desk", state: "todo", note: null },
  ],
  connected: null,
  way: "cli",
  now: {
    kind: "offer",
    title: "GitHub is signed in on this computer as kingsleyh",
    detail: "Through GitHub CLI. Desk gets the same access (repo, read:org), read only.",
    code: null,
    url: null,
    expiresAt: null,
    action: "use_cli",
    other: "other_way",
  },
  ended: null,
  write: false,
  forWhom: "Desk",
});

const asked: ChatMessage = { id: "u1", role: "user", content: "set up github", at: new Date(Date.now() - 2000).toISOString(), status: "complete", tools: [] };

/** The frames a hub sends while its agent sets GitHub up and waits on the
 *  person, word for word: the tool's name with what it asks, the heartbeat
 *  saying it again, and no answer text yet. */
const FRAMES: ServerMessage[] = [
  { type: "typing" },
  { type: "tool_start", content: "connections.setup: Set up GitHub for Desk: keep its key in the vault and turn it on, read only" },
  { type: "tool_start", content: "connections.setup: Set up GitHub for Desk: keep its key in the vault and turn it on, read only · 3s" },
  { type: "tool_end", content: "connections.setup (3100ms, ok)" },
  { type: "tool_start", content: "connections.wait: 0123456789abcdef0123456789abcdef" },
  { type: "tool_start", content: "connections.wait: 0123456789abcdef0123456789abcdef · 5s" },
  { type: "tool_start", content: "connections.wait: 0123456789abcdef0123456789abcdef · 10s" },
];

const live = (): ConversationState => FRAMES.reduce(reduce, { ...emptyConversation(), connected: true, messages: [asked] });

beforeEach(() => {
  setups.length = 0;
  setups.push(GITHUB(new Date().toISOString()));
  useDesk.setState({ activeRoom: null, hub: null });
  useChat.setState({
    hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }],
    roster: [{ hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: true }],
    activeAgent: "local/desk",
    histories: {},
  });
});
afterEach(cleanup);

it("counts the hub's live setup call once, its heartbeat no more", () => {
  const tools = live().messages.at(-1)!.tools;
  expect(tools.map((t) => t.name)).toEqual([
    "connections.setup: Set up GitHub for Desk: keep its key in the vault and turn it on, read only",
    "connections.wait: 0123456789abcdef0123456789abcdef",
  ]);
});

it("shows the setup's card while the turn still waits on it, before the agent has said anything", async () => {
  useChat.setState({ conversations: { "local/desk": live() } });
  render(<Rooms />);
  expect(await screen.findByText("GitHub is signed in on this computer as kingsleyh")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Use it" })).toBeTruthy();
  // In the working row: the turn is still under way.
  expect(document.querySelector(".msg-working .setup-card")).toBeTruthy();
});

it("puts a setup no message on screen shows at the top of the stage, and gives it back to the message that shows it", async () => {
  const dock = render(<Dock hub="local" api={api} showPage={async () => false} />);
  expect(await screen.findByText("GitHub is signed in on this computer as kingsleyh")).toBeTruthy();
  expect(screen.getByText(/Desk is setting up GitHub/)).toBeTruthy();
  // The conversation that asked for it opens: its message shows it, and the
  // stage's top no longer does.
  render(<SetupCards origin={{ hub: "local", agent: "desk" }} since={asked.at} count={1} api={api} showPage={async () => false} />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(screen.getAllByText("GitHub is signed in on this computer as kingsleyh")).toHaveLength(1);
  expect(dock.container.querySelector(".setup-card")).toBeNull();
});
