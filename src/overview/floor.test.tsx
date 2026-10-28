import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { HubError, type DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { ActivityPage, Overview, Session } from "../hub/types";
import { Floor } from "../floor/Floor";
import { DeskActions } from "./DeskActions";
import { useOverview } from "./store";

vi.mock("@workforce/rich", () => ({
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
  RichMarkdown: ({ text }: { text: string }) => text,
}));

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const overview = (over: Partial<Overview> = {}): Overview => ({
  brief: { text: "Two things need you.", at: ago(1), by: { id: "desk", name: "Desk" } },
  counts: { working: 2, needsYou: 2, doneToday: 1 },
  items: [
    {
      kind: "session",
      id: "s-web",
      name: "acme-web",
      engine: "claude",
      origin: "desk",
      state: "needs_you",
      task: "Upgrading the date picker",
      since: ago(6),
      approval: { id: "ap-1", summary: "Run npm install @acme/ds@4.2.0?" },
    },
    {
      kind: "agent",
      id: "scout",
      name: "Scout",
      state: "needs_you",
      task: "Preparing the staging deploy",
      since: ago(3),
      question: { text: "Should I deploy main or release/4.2 to staging?", options: ["main", "release/4.2"] },
    },
    { kind: "agent", id: "ledger", name: "Ledger", state: "working", task: "Comparing RDS spend", detail: "● aws.cost_explorer", since: ago(2) },
    { kind: "session", id: "s-e7", name: "workforce-e7", engine: "claude", origin: "desk", state: "quiet", task: "Provider list", lastActivity: ago(40) },
    { kind: "session", id: "s-pr", name: "dw-676-read-shadow", state: "done", detail: "Merged. Session closed." },
  ],
  ...over,
});

const page: ActivityPage = {
  events: [
    {
      id: "e2",
      at: ago(1),
      kind: "nudged",
      actor: { kind: "manager", id: "desk", name: "Desk" },
      subject: { kind: "session", id: "s-e7", name: "workforce-e7" },
      text: "asked workforce-e7 “Still on the provider tests, or stuck?”",
      reason: "Quiet for 40 min while working.",
    },
    { id: "e1", at: ago(3), kind: "question", actor: { kind: "agent", id: "scout", name: "Scout" }, subject: { kind: "agent", id: "scout", name: "Scout" }, text: "asked which branch to deploy" },
  ],
  more: false,
};

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  engine: "claude",
  name: id,
  goal: "",
  cwd: "/Users/you/acme-web",
  branch: null,
  origin: "desk",
  state: "blocked",
  live: true,
  cliSessionId: null,
  lastPrompt: null,
  lastReply: null,
  currentTool: null,
  pending: { id: "ap-1", tool: "Bash", detail: "npm install @acme/ds@4.2.0", since: ago(6), answerable: true },
  approvals: "desk",
  createdAt: ago(60),
  updatedAt: ago(6),
  ...over,
});

const hubWith = (over: Partial<DeskHub>): DeskHub =>
  ({
    overview: vi.fn(() => Promise.resolve(overview())),
    activity: vi.fn(() => Promise.resolve(structuredClone(page))),
    manager: vi.fn(() => Promise.resolve({ agentId: "desk", level: "suggest" })),
    suggestions: vi.fn(() => Promise.resolve([])),
    decide: vi.fn(() => Promise.resolve({})),
    acceptSuggestion: vi.fn(() => Promise.resolve({})),
    dismissSuggestion: vi.fn(() => Promise.resolve({})),
    ...over,
  }) as unknown as DeskHub;

const sendTo = vi.fn(() => Promise.resolve(true));

beforeEach(() => {
  useOverview.setState({
    overview: null,
    overviewSupport: "unknown",
    activitySupport: "unknown",
    feeds: {},
    manager: null,
    managerSupport: "unknown",
    suggestions: {},
    suggestionsLoaded: false,
    decided: {},
  });
  useDesk.setState({ sessions: {}, restore: [], openId: null, view: "floor" });
  useChat.setState({
    hubs: [{ id: "local", label: "This Mac", url: "http://127.0.0.1:1", local: true, token: "t" }],
    roster: [
      { hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: true },
      { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false },
    ],
    sendTo,
  });
  sendTo.mockClear();
});
afterEach(cleanup);

describe("the Floor", () => {
  it("stays as it was on a hub without the overview", async () => {
    const hub = hubWith({ overview: vi.fn(() => Promise.reject(new HubError(404, "This hub doesn’t have that yet."))) });
    useDesk.setState({ hub, sessions: { a: session("a", { name: "acme-web" }) } });
    render(<Floor onNewSession={() => {}} />);
    await waitFor(() => expect(useOverview.getState().overviewSupport).toBe("no"));
    expect(screen.getByRole("heading", { name: "Floor" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Activity" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
  });

  it("shows the brief, who needs you, who's working and what's done today, beside the activity", async () => {
    useDesk.setState({ hub: hubWith({}) });
    render(<Floor onNewSession={() => {}} />);
    expect(await screen.findByRole("region", { name: "Desk’s brief" })).toBeTruthy();
    expect(screen.getByText("Two things need you.")).toBeTruthy();
    const needs = screen.getByRole("region", { name: "Needs you" });
    expect(within(needs).getByText("acme-web")).toBeTruthy();
    expect(within(needs).getByText(/needs you · Claude Code · 6 min/)).toBeTruthy();
    expect(within(needs).getByText(/asked you a question · 3 min/)).toBeTruthy();
    const working = screen.getByRole("region", { name: "Working" });
    expect(within(working).getByText("working · quiet 40 min")).toBeTruthy();
    expect(within(working).getByText("● aws.cost_explorer")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Done today" })).getByText("Merged. Session closed.")).toBeTruthy();
    expect(screen.getByText(/2 working ·/).textContent).toBe("2 working · 2 need you · 1 done today");
    const rail = screen.getByRole("complementary", { name: "Activity" });
    expect(await within(rail).findByText("Quiet for 40 min while working.")).toBeTruthy();
    expect(within(rail).getByRole("radio", { name: "Desk’s actions" })).toBeTruthy();
  });

  it("answers an agent's question with one of its options, without leaving the Floor", async () => {
    useDesk.setState({ hub: hubWith({}) });
    render(<Floor onNewSession={() => {}} />);
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "release/4.2" })));
    expect(sendTo).toHaveBeenCalledWith("local/scout", "release/4.2");
    expect(screen.getByRole("status").textContent).toBe("You answered “release/4.2”.");
    expect(useDesk.getState().view).toBe("floor");
  });

  it("allows a session's request in place", async () => {
    const hub = hubWith({});
    useDesk.setState({ hub, sessions: { "s-web": session("s-web", { name: "acme-web" }) } });
    render(<Floor onNewSession={() => {}} />);
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needs).getByText("Run npm install @acme/ds@4.2.0?")).toBeTruthy();
    await act(async () => fireEvent.click(within(needs).getByRole("button", { name: "Allow" })));
    expect(hub.decide).toHaveBeenCalledWith("s-web", "ap-1", "allow");
  });

  it("offers to open only the sessions Desk lists", async () => {
    useDesk.setState({ hub: hubWith({}), sessions: { "s-e7": session("s-e7", { name: "workforce-e7", state: "working", pending: null }) } });
    render(<Floor onNewSession={() => {}} />);
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needs).queryByRole("button", { name: "Open" })).toBeNull();
    expect(within(needs).queryByRole("button", { name: /acme-web/ })).toBeNull();
    expect(within(needs).getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Done today" })).queryByRole("button")).toBeNull();
    fireEvent.click(within(screen.getByRole("region", { name: "Working" })).getByRole("button", { name: /workforce-e7/ }));
    expect(useDesk.getState().openId).toBe("s-e7");
  });

  it("has no brief card without an overseer, and the rest still works", async () => {
    useDesk.setState({
      hub: hubWith({ overview: vi.fn(() => Promise.resolve(overview({ brief: null }))), manager: vi.fn(() => Promise.resolve({ agentId: null, level: null })) }),
    });
    render(<Floor onNewSession={() => {}} />);
    expect(await screen.findByRole("region", { name: "Needs you" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /brief/ })).toBeNull();
    const rail = screen.getByRole("complementary", { name: "Activity" });
    await within(rail).findByText(/asked which branch/);
    expect(within(rail).queryByRole("radio", { name: /actions/ })).toBeNull();
  });

  it("switches the activity filter and leaves out the rail where the hub has no activity", async () => {
    const activity = vi.fn((q: { filter?: string }) =>
      q.filter === "needs_you" ? Promise.resolve({ events: [page.events[1]!], more: false }) : Promise.resolve(structuredClone(page)),
    );
    useDesk.setState({ hub: hubWith({ activity } as Partial<DeskHub>) });
    render(<Floor onNewSession={() => {}} />);
    const rail = await screen.findByRole("complementary", { name: "Activity" });
    fireEvent.click(within(rail).getByRole("radio", { name: "Needs you" }));
    await waitFor(() => expect(within(rail).queryByText("Quiet for 40 min while working.")).toBeNull());
    expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ filter: "needs_you" }));
    cleanup();
    useOverview.setState({ feeds: {}, activitySupport: "unknown" });
    useDesk.setState({ hub: hubWith({ activity: vi.fn(() => Promise.reject(new HubError(404, ""))) }) });
    render(<Floor onNewSession={() => {}} />);
    await screen.findByRole("region", { name: "Needs you" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Activity" })).toBeNull());
  });
});

describe("what the overseer's messages offer to act on", () => {
  it("allows a session's request from the DM, then says it was allowed", async () => {
    const hub = hubWith({});
    useDesk.setState({ hub, sessions: { "s-web": session("s-web") } });
    render(<DeskActions extras={{ approvals: [{ sessionId: "s-web", approvalId: "ap-1", summary: "Run npm install?" }] }} />);
    expect(screen.getByText(/Waiting 6 min · Claude Code in ~\/acme-web/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow" })));
    expect(hub.decide).toHaveBeenCalledWith("s-web", "ap-1", "allow");
    useDesk.setState({ sessions: { "s-web": session("s-web", { state: "working", pending: null }) } });
    expect(await screen.findByText("You allowed this.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("shows a request answered since as answered, with nothing to press", () => {
    useDesk.setState({ hub: hubWith({}), sessions: { "s-web": session("s-web", { pending: null, state: "working" }) } });
    render(<DeskActions extras={{ approvals: [{ sessionId: "s-web", approvalId: "ap-1", summary: "Run npm install?" }] }} />);
    expect(screen.getByText("Already answered.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does a suggestion, opens what it's about, or dismisses it, and shows what became of it", async () => {
    const hub = hubWith({
      suggestions: vi.fn(() =>
        Promise.resolve([
          { id: "sg-1", at: ago(1), text: "Stop the test.", action: {}, state: "open" as const, subject: { kind: "session" as const, id: "s-e7", name: "workforce-e7" } },
          { id: "sg-2", at: ago(1), text: "Ask Scout.", action: {}, state: "open" as const, subject: { kind: "agent" as const, id: "scout", name: "Scout" } },
        ]),
      ),
    });
    useDesk.setState({ hub, sessions: { "s-e7": session("s-e7", { state: "working", pending: null }) } });
    render(
      <DeskActions
        extras={{
          suggestions: [
            { id: "sg-1", text: "Stop the test.", state: "open" },
            { id: "sg-2", text: "Ask Scout.", state: "open" },
            { id: "sg-3", text: "An old one.", state: "dismissed" },
          ],
        }}
      />,
    );
    const [first, second, third] = screen.getAllByRole("group", { name: "Suggestion" });
    expect(within(third!).getByText("Dismissed.")).toBeTruthy();
    await act(async () => fireEvent.click(await within(first!).findByRole("button", { name: "Open session" })));
    expect(useDesk.getState().openId).toBe("s-e7");
    expect(within(second!).getByRole("button", { name: "Open Scout" })).toBeTruthy();
    await act(async () => fireEvent.click(within(first!).getByRole("button", { name: "Do it" })));
    expect(hub.acceptSuggestion).toHaveBeenCalledWith("sg-1");
    expect(within(first!).getByText("Done.")).toBeTruthy();
    await act(async () => fireEvent.click(within(second!).getByRole("button", { name: "Dismiss" })));
    expect(hub.dismissSuggestion).toHaveBeenCalledWith("sg-2");
    expect(within(second!).getByText("Dismissed.")).toBeTruthy();
    expect(hub.suggestions).toHaveBeenCalledTimes(1);
  });

  it("says plainly when a suggestion couldn't be done", async () => {
    useDesk.setState({ hub: hubWith({ acceptSuggestion: vi.fn(() => Promise.reject(new HubError(404, "gone"))) }) });
    render(<DeskActions extras={{ suggestions: [{ id: "sg-1", text: "Stop the test.", state: "open" }] }} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Do it" })));
    expect(screen.getByText("That isn’t there any more.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Do it" })).toBeTruthy();
  });
});
