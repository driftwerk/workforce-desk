import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { useDesk } from "../hub/store";
import { HubError, type DeskHub } from "../hub/client";
import type { Room, Session } from "../hub/types";
import { openTarget } from "../shell/navigate";
import { RightNow } from "./RightNow";
import { useFloor } from "./store";
import { NOW, agent, approval, at, fakeFetch, fakeHub, hub, need, ready, session, view, work, type FakeHub } from "./testing";
import { clock, dayClock } from "./time";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("@workforce/rich", () => ({
  RichMarkdown: ({ text }: { text: string }) => text,
  RichHostProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../shell/navigate", () => ({ openTarget: vi.fn() }));

const room: Room = { id: "r1", slug: "launch", name: "Launch", members: [], defaultMember: null, createdAt: "", updatedAt: "" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(openTarget).mockClear();
  useDesk.setState({ rooms: { r1: room } });
  useChat.setState({ hubs: [hub("local"), hub("b")] });
  useFloor.setState({
    day: Date.parse("2026-10-29T00:00:00Z"),
    deciding: {},
    problems: {},
    answered: {},
    hubs: {
      local: ready(
        view({
          needs: [approval("ap-1", "s-1", { who: session("s-1", "acme-web"), ask: "Run npm test?", since: at(12) })],
          working: [work(session("s-2", "repo"), { since: at(38), heardAt: at(1), background: { count: 2, since: at(6) } })],
          done: [work(agent("herald", "Herald"), { what: "Labelled 3 issues.", since: at(98), endedAt: at(50), outcome: "finished" })],
        }),
      ),
      b: ready(
        view({
          needs: [
            need("q-1", agent("scout", "Scout"), { ask: "Main or release?", since: at(30), place: { kind: "room", room: "r1", thread: "m-1" } }),
          ],
          working: [work(agent("ledger", "Ledger"), { what: "● aws.cost_explorer", since: at(10), heardAt: at(0) })],
          done: [
            work(agent("ops", "Ops"), {
              what: "Deploy failed.",
              place: { kind: "slack", team: null, channel: "C1", thread: null },
              endedAt: at(20),
              outcome: "failed",
            }),
          ],
        }),
        { stale: true, at: at(20) },
      ),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Right now's needs, each its own list item. */
const needRows = () => within(screen.getByRole("list", { name: "Waiting on you" })).getAllByRole("listitem");

const gist = (now: string, purpose: string | null, min: number) => ({ purpose, now, at: at(min) });

describe("Right now", () => {
  it("lists what needs you, then one entry per agent or session, working, waiting, then done", () => {
    render(<RightNow brief={null} />);
    const [first, second] = needRows().map((r) => within(r).getAllByRole("button")[0]);
    expect(first!.textContent).toContain("Scout");
    expect(first!.textContent).toContain(`waiting 30m · since ${dayClock(at(30), NOW)}`);
    expect(first!.textContent).toContain("Main or release? · in Launch");
    expect(second!.textContent).toContain("Run npm test?");
    const list = screen.getByRole("group", { name: "What’s happening" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.querySelector("b")!.textContent)).toEqual(["Ledger", "repo", "Ops", "Herald"]);
    expect(within(list).getByText(`waiting on 2 background tasks · updated ${clock(at(1))}`)).toBeTruthy();
    expect(rows[1]!.querySelector(".dot-background")).toBeTruthy();
    expect(rows[2]!.querySelector(".dot-failed")).toBeTruthy();
    expect(within(list).getByText(`working · updated ${clock(at(0))}`)).toBeTruthy();
  });

  it("says each entry's purpose and what it is doing, in the hub's words, when it was written", () => {
    useFloor.setState({
      hubs: {
        local: ready(
          view({
            working: [
              work(session("s-2", "repo"), {
                since: at(20),
                gist: gist("Right now it is moving the Windows support onto the released code.", "Getting Desk ready for its first release.", 3),
              }),
              work(session("s-2", "repo"), { since: at(40), gist: gist("An older turn.", null, 30) }),
            ],
            done: [
              work(session("s-2", "repo"), { what: "Merged #5.", endedAt: at(50), outcome: "finished" }),
              work(agent("herald", "Herald"), { what: "Done.", endedAt: at(150), outcome: "finished" }),
            ],
          }),
        ),
      },
    });
    render(<RightNow brief={null} />);
    const rows = within(screen.getByRole("group", { name: "What’s happening" })).getAllByRole("button");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain(
      "Getting Desk ready for its first release. Right now it is moving the Windows support onto the released code.",
    );
    expect(rows[0]!.textContent).toContain(`working · updated ${clock(at(3))}`);
    expect(screen.queryByText(/Herald/)).toBeNull();
  });

  it("folds a session an agent's turn ran as into that agent's one entry, by its name", () => {
    const cwd = "/Users/me/Library/Application Support/Desk/hub/data/agents/scout/projects/_agent-turn/work/session/at-dm-d4774cbb6c89";
    useDesk.setState({ sessions: { "s-9": { id: "s-9", engine: "claude", name: "at-dm-d4774cbb6c89", cwd, origin: "external" } as Session } });
    useChat.setState({ roster: [{ hubId: "local", id: "scout", name: "Scout", model: null, provider: "claude-code", isDefault: false }] });
    useFloor.setState({
      hubs: {
        local: ready(
          view({
            working: [work(session("s-9", "at-dm-d4774cbb6c89"), { heardAt: at(1) })],
            done: [work(agent("scout", "Scout"), { what: "Checked the spend.", endedAt: at(30), outcome: "finished" })],
          }),
        ),
      },
    });
    render(<RightNow brief={null} />);
    const rows = within(screen.getByRole("group", { name: "What’s happening" })).getAllByRole("button");
    expect(rows.map((r) => r.querySelector("b")!.textContent)).toEqual(["Scout"]);
    expect(screen.getByText(/^Scout is under way\./)).toBeTruthy();
    fireEvent.click(rows[0]!);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "agent", key: "local/scout" }, { beside: true });
  });

  describe("an agent's turn the hub ran as a session", () => {
    const turn = session("s-9", "at-dm-d4774cbb6c89-2e");
    const cwd = "/Users/me/Library/Application Support/Desk/hub/data/agents/desk/projects/_agent-turn/work/session/at-dm-d4774cbb6c89";
    const show = (works: ReturnType<typeof work>[]) =>
      useFloor.setState({ hubs: { local: ready(view({ done: works, lanes: [{ who: turn, spans: [{ kind: "working", from: at(40), to: at(10) }] }] })) } });
    beforeEach(() => {
      useChat.setState({ roster: [{ hubId: "local", id: "desk", name: "Desk", model: null, provider: "claude-code", isDefault: false }] });
    });
    afterEach(() => useDesk.setState({ sessions: {}, restore: [] }));

    it("is not shown when Desk knows no folder for it, as it has ended", () => {
      useDesk.setState({ sessions: {}, restore: [] });
      show([work(turn, { endedAt: at(10), outcome: "limit" })]);
      render(<RightNow brief={null} />);
      const list = screen.getByRole("group", { name: "What’s happening" });
      expect(within(list).queryAllByRole("button")).toHaveLength(0);
      expect(document.body.textContent).not.toMatch(/Agent turn|at-dm-/);
    });

    it("is its agent's entry when its folder says whose it is, failed at the limit too", () => {
      useDesk.setState({ sessions: { "s-9": { id: "s-9", engine: "claude", name: turn.name, cwd, origin: "external" } as Session } });
      show([work(turn, { endedAt: at(10), outcome: "limit" }), work(agent("desk", "Desk"), { endedAt: at(40), outcome: "finished" })]);
      render(<RightNow brief={null} />);
      const rows = within(screen.getByRole("group", { name: "What’s happening" })).getAllByRole("button");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.querySelector("b")!.textContent).toBe("Desk");
      expect(rows[0]!.textContent).toContain(`failed · updated ${clock(at(10))}`);
      expect(rows[0]!.textContent).toContain("Stopped at its plan’s limit 10 min ago.");
      expect(rows[0]!.querySelector(".dot-failed")).toBeTruthy();
    });
  });

  it("says, for a hub without gists, what Desk knows: never the person's prompt", () => {
    useDesk.setState({ sessions: { "s-4": { id: "s-4", engine: "claude", name: "", cwd: "/Users/me/dev/acme-web", origin: "desk" } as Session } });
    useFloor.setState({
      hubs: {
        local: ready(
          view({
            working: [
              work(session("s-4", ""), { what: "classify is off - merge it", heardAt: at(2) }),
              work(agent("scout", "Scout"), { what: "Look at #12 and land it", heardAt: at(4) }),
            ],
            done: [work(agent("ops", "Ops"), { what: "Merged PR #5 into main.", endedAt: at(8), outcome: "finished" })],
          }),
        ),
      },
    });
    render(<RightNow brief={null} />);
    const list = screen.getByRole("group", { name: "What’s happening" });
    expect(within(list).getByText("Working on acme-web.")).toBeTruthy();
    expect(within(list).getByText("Working on it now.")).toBeTruthy();
    expect(within(list).getByText("Finished 8 min ago.")).toBeTruthy();
    expect(list.textContent).not.toMatch(/classify|land it|Merged/);
    useDesk.setState({ sessions: {} });
  });

  it("keeps a long list in one place of its own, which scrolls", () => {
    useFloor.setState({
      hubs: {
        local: ready(
          view({
            done: Array.from({ length: 30 }, (_, i) =>
              work(agent(`a${i}`, `Agent ${i}`), { what: `Finished ${i}.`, endedAt: at(i), outcome: "finished" }),
            ),
          }),
        ),
      },
    });
    render(<RightNow brief={null} />);
    const group = screen.getByRole("group", { name: "What’s happening" });
    const list = group.querySelector(".right-now-list")!;
    expect(within(list as HTMLElement).getAllByRole("button")).toHaveLength(30);
    expect(within(group).getByRole("heading").closest(".right-now-list")).toBeNull();
    expect(group.querySelectorAll(".right-now-list")).toHaveLength(1);
    expect(within(screen.getByRole("list", { name: "Waiting on you" })).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("says so with nothing in either list", () => {
    useFloor.setState({ hubs: { local: ready(view()) } });
    render(<RightNow brief={null} />);
    expect(within(screen.getByRole("group", { name: "Needs you · 0" })).getByText("Nothing is waiting on you.")).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "What’s happening" })).getByText(
        "Nothing is running, and nothing has finished in the last two hours.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Nothing is running right now. Nothing needs you.")).toBeTruthy();
  });

  it("marks what an unreachable hub said last, and says since when", () => {
    render(<RightNow brief={null} />);
    const scout = within(screen.getByRole("group", { name: "Needs you · 2" })).getAllByRole("button")[0]!;
    expect(scout.className).toContain("floor-stale");
    expect(scout.title).toBe(`Hub b unreachable since ${clock(at(20))}`);
  });

  it("is summed up by the overseer's brief, else the hubs' paragraph, else Desk's", () => {
    render(<RightNow brief={<p>Overseer’s word.</p>} />);
    expect(screen.getByText("Overseer’s word.")).toBeTruthy();
    expect(screen.queryByText(/^updated /)).toBeNull();
    cleanup();
    render(<RightNow brief={null} />);
    expect(screen.getByText("Ledger and repo are under way. Ops and Herald finished lately. Two things need you.")).toBeTruthy();
    cleanup();
    useFloor.setState((s) => ({
      hubs: { ...s.hubs, b: { ...s.hubs.b!, floor: { ...s.hubs.b!.floor!, summary: { text: "The release shipped.", at: at(7) } } } },
    }));
    render(<RightNow brief={null} />);
    expect(screen.getByText("The release shipped. Two things need you.")).toBeTruthy();
    expect(screen.getByText(`updated ${clock(at(7))}`)).toBeTruthy();
  });

  it("opens each row beside the Floor, or where it is when that's a room or Slack", () => {
    render(<RightNow brief={null} />);
    const click = (group: string, i: number) => fireEvent.click(within(screen.getByRole("group", { name: group })).getAllByRole("button")[i]!);
    const open = (i: number) => fireEvent.click(within(needRows()[i]!).getAllByRole("button")[0]!);
    open(0);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "room", roomId: "r1", threadId: "m-1" }, { beside: true });
    open(1);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "session", sessionId: "s-1" }, { beside: true });
    click("What’s happening", 0);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "agent", key: "b/ledger" }, { beside: true });
    click("What’s happening", 1);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "session", sessionId: "s-2" }, { beside: true });
    // An agent's entry is the agent: its DM, wherever its turn was.
    click("What’s happening", 2);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "agent", key: "b/ops" }, { beside: true });
  });
});

describe("Right now's needs, answered in place", () => {
  const asked = { id: "s-4", engine: "claude", name: "keychain-check", cwd: "/tmp", origin: "desk", state: "asking" } as Session;
  const refused = {
    ask: "Stopped: Bash was not allowed",
    why: "auto mode refused Bash",
    options: null,
    denied: { tool: "Bash(security find-generic-password)", detail: "security find-generic-password", reason: "[Credential Exploration]", allowable: true },
  };
  let hubs: Record<string, FakeHub>;
  const show = (needs: ReturnType<typeof need>[]) => {
    hubs = { local: fakeHub({ floor: view({ needs }) }) };
    vi.stubGlobal("fetch", fakeFetch(hubs));
    useChat.setState({ hubs: [hub("local")], roster: [{ hubId: "local", id: "scout", name: "Scout", model: null, provider: "claude-code", isDefault: false }] });
    useFloor.setState({ hubs: { local: ready(structuredClone(hubs.local!.floor!)) } });
  };
  const npmTest = approval("ap-1", "s-1", { who: session("s-1", "acme-web"), ask: "Run npm test?" });
  /** What a row's buttons say they do, but its body's, which the mouse opens it by. */
  const actions = (row: HTMLElement) =>
    within(row)
      .getAllByRole("button")
      .filter((b) => b.tabIndex !== -1)
      .map((b) => b.getAttribute("aria-label"));
  beforeEach(() => {
    useDesk.setState({ sessions: { "s-1": { id: "s-1", name: "acme-web", cwd: "/tmp", origin: "desk", state: "blocked" } as Session } });
  });
  afterEach(() => useDesk.setState({ sessions: {}, hub: null }));

  it("offers each kind of need its answers, every button naming whose need it answers", () => {
    useDesk.setState((s) => ({ sessions: { ...s.sessions, "s-4": { ...asked, asked: refused }, "s-3": { ...asked, id: "s-3", name: "repo", state: "blocked" } } }));
    show([
      npmTest,
      need("question:t2", agent("scout", "Scout"), { ask: "Main or release?", since: at(9) }),
      approval("wait:t3", "s-3", { who: session("s-3", "repo"), ask: "Run rm -rf build?", answer: { kind: "terminal" }, since: at(8) }),
      need("question:t4", session("s-4", "keychain-check"), { ask: refused.ask, since: at(7) }),
    ]);
    render(<RightNow brief={null} />);
    expect(needRows().map(actions)).toEqual([
      ["Allow “Run npm test?” for acme-web", "Deny “Run npm test?” for acme-web", "Open acme-web"],
      ["Reply to Scout…", "Open Scout"],
      ["Open repo to answer in the terminal"],
      ["Allow this command for this session and continue: keychain-check", "Reply to keychain-check…", "Open keychain-check", "Dismiss what keychain-check asked"],
    ]);
    // What the buttons show stays short; the row says whose it is.
    expect(within(needRows()[0]!).getByRole("button", { name: /^Allow/ }).textContent).toBe("Allow");
    expect(within(needRows()[1]!).getByRole("button", { name: /^Reply/ }).textContent).toBe("Reply…");
    // Each row is one item; its buttons sit beside its body, never in it.
    for (const row of needRows()) expect(row.querySelector("button button")).toBeNull();
  });

  it("allows and denies through the floor's own answer, without opening the row", async () => {
    show([npmTest, approval("ap-2", "s-1", { who: session("s-1", "acme-web"), ask: "Run npm install?", since: at(5) })]);
    render(<RightNow brief={null} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow “Run npm test?” for acme-web" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Deny “Run npm install?” for acme-web" })));
    expect(hubs.local!.decided).toEqual([
      { at: { kind: "session", sessionId: "s-1", approvalId: "ap-1" }, choice: "allow" },
      { at: { kind: "session", sessionId: "s-1", approvalId: "ap-2" }, choice: "deny" },
    ]);
    expect(openTarget).not.toHaveBeenCalled();
    await act(() => vi.waitFor(() => expect(hubs.local!.days).toHaveLength(1)));
  });

  it("opens from the row's body, beside the Floor, and replies there too", () => {
    show([npmTest, need("question:t2", agent("scout", "Scout"), { ask: "Main or release?", since: at(9) })]);
    render(<RightNow brief={null} />);
    fireEvent.click(within(needRows()[0]!).getAllByRole("button")[0]!);
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "session", sessionId: "s-1" }, { beside: true });
    // Its Open, the way there from the keyboard, opens it beside the Floor too.
    fireEvent.click(screen.getByRole("button", { name: "Open acme-web" }));
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "session", sessionId: "s-1" }, { beside: true, reply: false });
    fireEvent.click(screen.getByRole("button", { name: "Reply to Scout…" }));
    expect(openTarget).toHaveBeenLastCalledWith({ kind: "agent", key: "local/scout" }, { beside: true, reply: true });
  });

  it("holds both answers while one is on its way, and answers once however often it's pressed", async () => {
    show([npmTest]);
    let answer = (_: Response) => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) =>
        init?.method === "POST" ? new Promise<Response>((r) => (answer = r)) : fakeFetch(hubs)(input, init),
      ),
    );
    render(<RightNow brief={null} />);
    const deny = screen.getByRole("button", { name: "Deny “Run npm test?” for acme-web" });
    deny.focus();
    await act(async () => fireEvent.click(deny));
    await act(async () => fireEvent.click(deny));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Allow/ })));
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(deny.textContent).toBe("Denied…");
    expect(deny.getAttribute("aria-label")).toBe("Denied… “Run npm test?” for acme-web");
    expect(screen.getByRole("button", { name: /^Allow/ }).getAttribute("aria-disabled")).toBe("true");
    expect(deny.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(deny);
    expect(screen.getAllByRole("status").map((r) => r.textContent)).toContain("Denied");
    await act(async () => answer(new Response(null, { status: 204 })));
    await act(() => vi.waitFor(() => expect(hubs.local!.days).toHaveLength(1)));
  });

  it("says plainly why an answer didn't go through, and lets it be tried again", async () => {
    show([npmTest]);
    hubs.local!.decide = () => 403;
    render(<RightNow brief={null} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow “Run npm test?” for acme-web" })));
    expect(within(needRows()[0]!).getByRole("alert").textContent).toBe("Desk isn’t allowed to do that on this computer.");
    const allow = screen.getByRole("button", { name: "Allow “Run npm test?” for acme-web" });
    expect(allow.getAttribute("aria-disabled")).toBe("false");
    expect(openTarget).not.toHaveBeenCalled();
  });

  it("drops the row once it's answered, its focus left on the list", async () => {
    show([npmTest]);
    hubs.local!.decide = () => {
      hubs.local!.floor = view();
      return 204;
    };
    render(<RightNow brief={null} />);
    const allow = screen.getByRole("button", { name: "Allow “Run npm test?” for acme-web" });
    allow.focus();
    await act(async () => fireEvent.click(allow));
    await act(() => vi.waitFor(() => expect(hubs.local!.days).toHaveLength(1)));
    await act(() => useFloor.getState().load("local"));
    expect(screen.queryByRole("button", { name: /Run npm test/ })).toBeNull();
    expect(screen.getByRole("group", { name: "Needs you · 0" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("list", { name: "Waiting on you" }));
  });

  it("allows a refused tool for an asked session, or dismisses it, holding both while it goes", async () => {
    let done = () => {};
    const allowAsked = vi.fn(() => new Promise<Session>((r) => (done = () => r(asked))));
    const dismissAsked = vi.fn(() => Promise.resolve(asked));
    useDesk.setState({ hub: { allowAsked, dismissAsked } as unknown as DeskHub, sessions: { "s-4": { ...asked, asked: refused } } });
    show([need("question:t4", session("s-4", "keychain-check"), { ask: refused.ask })]);
    render(<RightNow brief={null} />);
    const allow = screen.getByRole("button", { name: "Allow this command for this session and continue: keychain-check" });
    const dismiss = screen.getByRole("button", { name: "Dismiss what keychain-check asked" });
    fireEvent.click(allow);
    expect(allowAsked).toHaveBeenCalledWith("s-4");
    expect((allow as HTMLButtonElement).disabled).toBe(true);
    expect((dismiss as HTMLButtonElement).disabled).toBe(true);
    await act(async () => done());
    fireEvent.click(dismiss);
    expect(dismissAsked).toHaveBeenCalledWith("s-4");
    expect(openTarget).not.toHaveBeenCalled();
  });

  it("says plainly, on its row, why an asked session's answer didn't go through", async () => {
    const allowAsked = vi.fn(() => Promise.reject(new HubError(403, "not_yours")));
    useDesk.setState({ hub: { allowAsked } as unknown as DeskHub, sessions: { "s-4": { ...asked, asked: refused } }, error: null });
    show([need("question:t4", session("s-4", "keychain-check"), { ask: refused.ask })]);
    render(<RightNow brief={null} />);
    const allow = screen.getByRole("button", { name: "Allow this command for this session and continue: keychain-check" });
    await act(async () => fireEvent.click(allow));
    expect(within(needRows()[0]!).getByRole("alert").textContent).toBe("Desk isn’t allowed to do that on this computer.");
    expect((allow as HTMLButtonElement).disabled).toBe(false);
    expect(useDesk.getState().error).toBeNull();
  });
});
