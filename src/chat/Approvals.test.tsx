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

  it("names a tool as a person reads it, and an MCP server as it named itself", () => {
    render(<PromptCard prompt={call("github.issue_create")} onAnswer={() => true} />);
    const card = screen.getByRole("group", { name: "Asks you first" });
    expect(card.textContent).toContain("Wants to use GitHub: issue create");
    expect(card.textContent).not.toContain("github.issue_create");
    cleanup();
    render(<PromptCard prompt={call("mcp__github__create_issue")} onAnswer={() => true} />);
    expect(screen.getByRole("group").textContent).toContain("Wants to use GitHub: create issue");
    expect(screen.getByRole("group").textContent).toContain("through the MCP server “github”");
    cleanup();
    render(<PromptCard prompt={call("exec.run")} onAnswer={() => true} />);
    expect(screen.getByRole("group").textContent).toContain("Wants to run a command");
    expect(screen.getByRole("group").textContent).not.toContain("Run a command: run");
    cleanup();
    // The hub's words lead; the tool isn't said twice.
    render(<PromptCard prompt={call("github.issue_create", "Open an issue in acme/web")} onAnswer={() => true} />);
    expect(screen.getByRole("group").textContent!.match(/GitHub: issue create/g)).toHaveLength(1);
  });

  const allow = (prompt: ReturnType<typeof call>, agent = "dw/sarah") => {
    render(<PromptCard prompt={prompt} agent={agent} onAnswer={() => true} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    cleanup();
  };
  const said = (prompt: ReturnType<typeof call>, agent = "dw/sarah") => {
    render(<PromptCard prompt={prompt} agent={agent} onAnswer={() => true} />);
    const note = screen.queryByText(/You’ve allowed exactly this/);
    const buttons = screen.getAllByRole("button").map((b) => [b.textContent, b.className.includes("btn-approve")]);
    cleanup();
    return { note: note !== null, buttons };
  };

  it("learns exactly this call, and only says so: Allow once stays first and primary", () => {
    const issue = call("github.issue_create", "Open an issue “Flaky test” in acme/web");
    allow(issue);
    allow(issue);
    const now = said(issue);
    expect(now.note).toBe(true);
    expect(now.buttons).toEqual([
      ["Allow once", true],
      ["Always allow", false],
      ["Deny", false],
    ]);
    // Other words are another call; another agent or workspace counts its own.
    expect(said(call("github.issue_create", "Open an issue “Delete prod” in acme/web")).note).toBe(false);
    expect(said(issue, "dw/allan").note).toBe(false);
    expect(said(issue, "acme/sarah").note).toBe(false);
    // Denying forgets it.
    render(<PromptCard prompt={issue} agent="dw/sarah" onAnswer={() => true} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    cleanup();
    expect(said(issue).note).toBe(false);
  });

  it("never learns what runs a command, sends to people or can't say what it does", () => {
    for (const p of [call("bash", "npm test"), call("messaging.send", "Tell #general we shipped"), call("github.issue_create")]) {
      allow(p);
      allow(p);
      allow(p);
      expect(said(p).note, p.tool).toBe(false);
    }
  });

  it("keeps no command or argument, only a digest of it", () => {
    const secret = call("github.issue_create", "Use token ghp_SECRETSECRETSECRET");
    allow(secret);
    expect(localStorage.getItem("desk.approvals.allowed")).not.toContain("SECRET");
    expect(localStorage.getItem("desk.approvals.allowed")).not.toContain("github");
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
      "Allow every command in acme-web",
      "Deny",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Allow every command in acme-web" }));
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

  it("never learns a call on this computer, and says a folder's command grant is for every command", () => {
    const run = ask({ allow_session: true, allow_in_folder: "~/dev/acme-web", facts });
    for (let i = 0; i < 3; i++) {
      render(<PromptCard prompt={run} agent="local/desk" onAnswer={() => true} />);
      fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
      cleanup();
    }
    render(<PromptCard prompt={run} agent="local/desk" onAnswer={() => true} />);
    expect(screen.queryByText(/You’ve allowed/)).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Allow once", "Allow for this session", "Allow every command in acme-web", "Deny"]);
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

  it("for Sign in for me, names the site, waits for I'm signed in, and offers Cancel", () => {
    const onAnswer = vi.fn(() => true);
    render(
      <PromptCard
        prompt={ask({
          facts: { effect: "sign_in", connector: "browser:https://shop.example", why: "Waits while you sign in. Desk never sees your password" },
        })}
        onAnswer={onAnswer}
      />,
    );
    const card = screen.getByRole("group", { name: "Sign in for me" });
    expect(card.textContent).toContain("Sign in to shop.example");
    expect(card.textContent).toContain("Desk never sees your password");
    expect(card.textContent).not.toContain("the agent's own words");
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "I’m signed in" }));
    expect(onAnswer).toHaveBeenLastCalledWith("allow_once");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onAnswer).toHaveBeenLastCalledWith("deny_once");
  });
});
