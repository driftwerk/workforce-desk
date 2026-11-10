import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { emptyConversation } from "../chat/conversation";
import { forgetCommands } from "../chat/commands";
import { useChat, type History } from "../chat/store";
import type { ChatMessage } from "../chat/types";
import { setDevToken } from "../hub/devTokens";
import { useDesk } from "../hub/store";
import { servePictures } from "../pictures/testing";
import { Rooms } from "./Rooms";

// A DM's composer offers the agent's commands as you type `/`, a command
// and its answer show as one settled here, and a message the hub never had
// says so, with Retry and Remove.

vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));

Element.prototype.scrollIntoView = () => {};
setDevToken("dw", "tok");

const COMMANDS = {
  commands: [
    { name: "new", args: "[model]", aliases: ["n"], summary: "Start a fresh session (optionally with a different model)" },
    { name: "reset", args: "", aliases: ["r", "clear"], summary: "Clear session history" },
    { name: "status", args: "", aliases: ["s"], summary: "Show session info (model, tokens, channel)" },
    { name: "skills", args: "", aliases: [], summary: "List the agent's skills and whether each is ready" },
  ],
};

const msg = (id: string, role: ChatMessage["role"], content: string, more: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  content,
  at: "2026-11-10T09:00:00.000Z",
  status: "complete",
  tools: [],
  ...more,
});

const ready: History = { state: "ready", messages: [], more: false, earlier: "idle", loadedAt: "2026-11-10T09:00:00.000Z" };

const show = (live: ChatMessage[] = [], listed: unknown = COMMANDS) => {
  servePictures((url) =>
    url.pathname === "/api/commands"
      ? listed === null
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify(listed), { headers: { "content-type": "application/json" } })
      : new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  useChat.setState({
    hubs: [{ id: "dw", label: "Driftwerk", url: "https://dw", local: false, revision: "t" }],
    roster: [{ hubId: "dw", id: "atlas", name: "Atlas", model: null, provider: null, isDefault: false }],
    activeAgent: "dw/atlas",
    conversations: { "dw/atlas": { ...emptyConversation(), connected: true, messages: live } },
    histories: { "dw/atlas": ready },
  });
  render(<Rooms />);
};

const box = () => screen.getByPlaceholderText("Message Atlas") as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(box(), { target: { value, selectionStart: value.length, selectionEnd: value.length } });

beforeEach(() => {
  forgetCommands();
  useDesk.setState({ activeRoom: null, hub: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the / menu", () => {
  it("lists the agent's commands with what each does as you type / at the start", async () => {
    show();
    type("/");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
    expect(screen.getAllByRole("option")[2]!.textContent).toBe("/statusShow session info (model, tokens, channel)");
    expect(box().getAttribute("role")).toBe("combobox");
    type("/cl");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["/resetClear session history"]);
    type("say /s");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  });

  it("puts the one you pick in the box; Escape closes it", async () => {
    show();
    type("/ne");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("/new ");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    type("/s");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Tab" });
    expect(box().value).toBe("/skills");
    type("/");
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  });

  it("sends a command typed out whole with Enter", async () => {
    const sent = vi.fn(() => true);
    const real = useChat.getState().send;
    useChat.setState({ send: sent });
    onTestFinished(() => useChat.setState({ send: real }));
    show();
    type("/status");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(sent).toHaveBeenCalledWith("dw/atlas", "/status");
  });

  it("isn't offered by a hub that lists no commands", async () => {
    show([], null);
    type("/");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  });
});

describe("a DM's settled and undelivered messages", () => {
  it("shows a command and its answer as a command, only here", () => {
    show([
      msg("m1", "user", "/status", { clientId: "c1", command: true, unkept: true }),
      msg("m2", "assistant", "Model: sonnet", { replyTo: "c1", command: true, unkept: true }),
    ]);
    const [asked, answer] = [...document.querySelectorAll(".msg-command")];
    expect(asked!.querySelector("code")!.textContent).toBe("/status");
    expect(asked!.textContent).toContain("Command");
    expect(answer!.textContent).toContain("Only here");
    expect(screen.queryByText("Not delivered")).toBeNull();
  });

  it("says a message wasn't delivered, and sends it again or takes it away", () => {
    const retry = vi.fn(() => true);
    const discard = vi.fn();
    const { retry: realRetry, discard: realDiscard } = useChat.getState();
    useChat.setState({ retry, discard });
    onTestFinished(() => useChat.setState({ retry: realRetry, discard: realDiscard }));
    show([msg("m1", "user", "deploy it", { clientId: "c1", undelivered: true })]);
    expect(screen.getByText("Not delivered")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledWith("dw/atlas", "m1");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(discard).toHaveBeenCalledWith("dw/atlas", "m1");
  });
});
