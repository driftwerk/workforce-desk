import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../hubs/surface", () => ({ decideApproval: vi.fn() }));

const { decideApproval } = await import("../hubs/surface");
const { useChat } = await import("./store");
const { useUi } = await import("../shell/ui");
const { PromptCard, RoutedApproval } = await import("./Approvals");

beforeEach(() => {
  localStorage.clear();
  useChat.setState({ hubs: [{ id: "dw", label: "Driftwerk", url: "https://dw.example", local: false, revision: "t" }] });
  vi.mocked(decideApproval).mockReset();
});
afterEach(cleanup);

describe("an approval routed to a conversation", () => {
  it("says what became of it where focus was, in a region that announces it", async () => {
    vi.mocked(decideApproval).mockResolvedValue("approved");
    render(<RoutedApproval hubId="dw" requestId="q1" />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Waiting for your answer");
    const approve = screen.getByRole("button", { name: "Approve" });
    approve.focus();
    await act(async () => fireEvent.click(approve));
    expect(decideApproval).toHaveBeenCalledWith(expect.objectContaining({ id: "dw" }), "q1", "allow_once");
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("You approved this.");
    expect(document.activeElement).toBe(status);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers Reconnect when its workspace isn't connected any more", () => {
    const opened = vi.fn();
    useUi.setState({ openSettings: opened } as never);
    render(<RoutedApproval hubId="gone" requestId="q1" />);
    expect(screen.getByText("Its workspace isn’t connected to Desk any more.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(opened).toHaveBeenCalledWith("hubs");
  });

  it("alerts you when the answer didn't go through, and keeps its buttons", async () => {
    vi.mocked(decideApproval).mockRejectedValue(new Error("Desk said no."));
    render(<RoutedApproval hubId="dw" requestId="q1" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Deny" })));
    expect(screen.getByRole("alert").textContent).toBe("Desk said no.");
    expect(screen.getByRole("button", { name: "Deny" })).toHaveProperty("disabled", false);
  });
});

describe("a tool call waiting on you", () => {
  it("alerts you when the agent can't be reached to answer, and tries the same answer again", () => {
    const prompt = { requestId: "q1", content: "Run npm test", tool: "bash", options: { allow_once: true, deny_once: true, allow_always: false, deny_always: false }, turnRef: null };
    const onAnswer = vi.fn(() => false);
    render(<PromptCard prompt={prompt} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(screen.getByRole("alert").textContent).toMatch(/isn’t connected/);
    onAnswer.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onAnswer).toHaveBeenLastCalledWith("allow_once");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  const call = (tool: string, content = "") => ({
    requestId: "q1",
    content,
    tool,
    options: { allow_once: true, deny_once: true, allow_always: true, deny_always: false },
    turnRef: null,
  });

  it("names a tool as a person reads it, never by its id", () => {
    render(<PromptCard prompt={call("github.issue_create")} onAnswer={() => true} />);
    const card = screen.getByRole("group", { name: "Asks you first" });
    expect(card.textContent).toContain("Wants to use GitHub: issue create");
    expect(card.textContent).not.toContain("github.issue_create");
    cleanup();
    render(<PromptCard prompt={call("mcp__linear__create_issue")} onAnswer={() => true} />);
    expect(screen.getByRole("group").textContent).toContain("Linear: create issue");
  });

  it("learns: once allowed twice, it offers to allow it always, first, and still asks", () => {
    const onAnswer = vi.fn(() => true);
    for (let i = 0; i < 2; i++) {
      render(<PromptCard prompt={call("github.issue_create")} onAnswer={onAnswer} />);
      expect(screen.getAllByRole("button")[0]!.textContent).toBe("Allow once");
      fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
      cleanup();
    }
    render(<PromptCard prompt={call("github.issue_create")} onAnswer={onAnswer} />);
    expect(screen.getByText(/You’ve allowed this 2 times/)).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Always allow", "Allow once", "Deny"]);
    expect(screen.getByRole("button", { name: "Always allow" }).className).toContain("btn-approve");
    expect(screen.getByRole("button", { name: "Allow once" }).className).not.toContain("btn-approve");
    expect(onAnswer).toHaveBeenCalledTimes(2);
    // Another tool hasn't been learned.
    cleanup();
    render(<PromptCard prompt={call("github.repo_delete")} onAnswer={onAnswer} />);
    expect(screen.queryByText(/You’ve allowed this/)).toBeNull();
    // Denying forgets what was learned.
    cleanup();
    render(<PromptCard prompt={call("github.issue_create")} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    cleanup();
    render(<PromptCard prompt={call("github.issue_create")} onAnswer={onAnswer} />);
    expect(screen.queryByText(/You’ve allowed this/)).toBeNull();
  });
});

describe("Desk's own card for a call on this computer", () => {
  const ask = (options: Partial<import("./types").PromptOptions>) => ({
    requestId: "q1",
    content: "the agent's own words",
    tool: "exec.run",
    options: { allow_once: true, deny_once: true, allow_always: false, deny_always: false, ...options },
    turnRef: null,
  });
  const facts = { effect: "exec", command: "npm test", cwd: "~/dev/acme-web", why: "Runs on this computer" };

  it("shows the hub's facts, never the agent's words, and the four answers in order", () => {
    const onAnswer = vi.fn(() => true);
    render(<PromptCard prompt={ask({ allow_session: true, allow_in_folder: "~/dev/acme-web", facts })} onAnswer={onAnswer} />);
    const card = screen.getByRole("group", { name: "Desk asks" });
    expect(card.textContent).toContain("Wants to run a command");
    expect(card.textContent).toContain("npm test");
    expect(card.textContent).toContain("in ~/dev/acme-web");
    expect(card.textContent).toContain("Runs on this computer");
    expect(card.textContent).not.toContain("the agent's own words");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Allow once",
      "Allow for this session",
      "Always allow in acme-web",
      "Deny",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Always allow in acme-web" }));
    expect(onAnswer).toHaveBeenCalledWith("allow_in_folder");
    fireEvent.click(screen.getByRole("button", { name: "Allow for this session" }));
    expect(onAnswer).toHaveBeenCalledWith("allow_session");
  });

  it("offers Allow once and Deny alone for what always asks, and from a hub without grants", () => {
    render(<PromptCard prompt={ask({ facts: { ...facts, command: "git push --force", why: "Can't be undone" } })} onAnswer={() => true} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Allow once", "Deny"]);
    cleanup();
    render(<PromptCard prompt={ask({})} onAnswer={() => true} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Allow once", "Deny"]);
  });

  it("focuses no answer for you, and Enter answers nothing", () => {
    const onAnswer = vi.fn(() => true);
    render(<PromptCard prompt={ask({ allow_session: true, allow_in_folder: "~/dev/acme-web", facts })} onAnswer={onAnswer} />);
    expect(screen.getAllByRole("button").some((b) => b === document.activeElement)).toBe(false);
    const allow = screen.getByRole("button", { name: "Allow once" });
    allow.focus();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    allow.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("learns a command in its folder, never what can't be undone, and not another command", () => {
    const onAnswer = vi.fn(() => true);
    const run = (command: string, why = "Runs on this computer") =>
      ask({ allow_session: true, allow_in_folder: "~/dev/acme-web", facts: { ...facts, command, why } });
    for (let i = 0; i < 2; i++) {
      render(<PromptCard prompt={run("npm test")} onAnswer={onAnswer} />);
      fireEvent.click(screen.getByRole("button", { name: "Allow for this session" }));
      cleanup();
    }
    render(<PromptCard prompt={run("npm test")} onAnswer={onAnswer} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Always allow in acme-web", "Allow once", "Allow for this session", "Deny"]);
    cleanup();
    render(<PromptCard prompt={run("npm publish")} onAnswer={onAnswer} />);
    expect(screen.getAllByRole("button")[0]!.textContent).toBe("Allow once");
    cleanup();
    for (let i = 0; i < 3; i++) {
      render(<PromptCard prompt={run("rm -rf dist", "Can't be undone")} onAnswer={onAnswer} />);
      fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
      cleanup();
    }
    render(<PromptCard prompt={run("rm -rf dist", "Can't be undone")} onAnswer={onAnswer} />);
    expect(screen.queryByText(/You’ve allowed this/)).toBeNull();
    expect(screen.getAllByRole("button").some((b) => b.className.includes("btn-approve"))).toBe(false);
  });

  it("makes no answer primary for what can't be undone, and offers deleting in its folder", () => {
    render(
      <PromptCard
        prompt={ask({ allow_in_folder: "~/dev/acme-web", facts: { effect: "exec", command: "rm -rf node_modules", cwd: "~/dev/acme-web", why: "Can't be undone" } })}
        onAnswer={() => true}
      />,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Allow once", "Always allow deleting in acme-web", "Deny"]);
    expect(screen.getByRole("button", { name: "Allow once" }).className).not.toContain("btn-approve");
    cleanup();
    render(<PromptCard prompt={ask({ facts })} onAnswer={() => true} />);
    expect(screen.getByRole("button", { name: "Allow once" }).className).toContain("btn-approve");
  });

  it("names the connector a write would always be allowed to", () => {
    render(
      <PromptCard
        prompt={ask({ allow_in_folder: "linear", facts: { effect: "connector", connector: "linear", why: "Changes something in a connected service" } })}
        onAnswer={() => true}
      />,
    );
    expect(screen.getByRole("button", { name: "Always allow writes to linear" })).toBeTruthy();
  });
});
