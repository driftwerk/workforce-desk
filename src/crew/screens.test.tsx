import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../chat/types";
import { HubError, type DeskHub } from "../hub/client";
import type { Provider } from "../hub/providers";
import { useDesk } from "../hub/store";
import { BrainDialog } from "../providers/BrainDialog";
import { useProviders } from "../providers/store";
import { AgentFiles } from "./AgentFiles";
import { useDrafts } from "./files";

vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  onLoginProgress: () => Promise.resolve(() => {}),
  startLogin: vi.fn(() => Promise.resolve()),
  invoke: vi.fn(() => Promise.resolve()),
}));

const plan = (id: string, name: string, connected: boolean): Provider => ({
  id,
  name,
  group: id === "anthropic" ? "key" : "plan",
  description: "",
  connected,
  connect:
    id === "anthropic"
      ? { kind: "fields", hint: "Paste your key.", fields: [{ name: "api_key", label: "API key", secret: true }] }
      : { kind: "login", fields: [] },
  models: [
    { id: `${id}-big`, name: "Big", description: "Most capable", default: false },
    { id: `${id}-mid`, name: "Mid", description: "Everyday", default: true },
  ],
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
});

const fakeHub = (over: Partial<DeskHub> = {}): DeskHub =>
  ({
    identityFile: vi.fn(() => Promise.resolve("# Soul\n")),
    saveIdentityFile: vi.fn(() => Promise.resolve()),
    identityRevisions: vi.fn(() => Promise.reject(new HubError(503, "revision history requires Postgres"))),
    connectProvider: vi.fn((id: string) => Promise.resolve({ ...plan(id, "Anthropic API", true) })),
    ...over,
  }) as unknown as DeskHub;

beforeEach(() => {
  useProviders.setState({
    providers: [plan("claude-code", "Claude plan", true), plan("anthropic", "Anthropic API", false)],
    loaded: true,
    loading: false,
    problem: null,
  });
  useDrafts.setState({ drafts: {} });
});

afterEach(cleanup);

describe("How they think", () => {
  it("picks a model and effort per provider, connects one, and uses the choice", async () => {
    const hub = fakeHub();
    useDesk.setState({ hub });
    const onUse = vi.fn();
    const onClose = vi.fn();
    render(
      <BrainDialog
        title="How Ledger thinks"
        who="Ledger"
        initial={{ provider: "claude-code", model: "claude-code-mid", effort: "medium" }}
        onUse={onUse}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Ledger will use Mid on your Claude plan · Medium effort")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Mid/ }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "High" }));
    fireEvent.click(screen.getByRole("radio", { name: /Big/ }));
    expect(screen.getByText("Ledger will use Big on your Claude plan · High effort")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Anthropic API/ }));
    expect(screen.getByRole("heading", { name: "Connect Anthropic API" })).toBeTruthy();
    const use = screen.getByRole("button", { name: "Use this" }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByText("Ledger will use Mid on your Anthropic API · Medium effort")).toBeTruthy());
    expect(hub.connectProvider).toHaveBeenCalledWith("anthropic", { api_key: "sk-ant-test" });

    fireEvent.click(screen.getByRole("button", { name: /Claude plan/ }));
    expect(screen.getByText("Ledger will use Big on your Claude plan · High effort")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use this" })));
    expect(onUse).toHaveBeenCalledWith({ provider: "claude-code", model: "claude-code-big", effort: "high" });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape without the key reaching anything underneath", () => {
    useDesk.setState({ hub: fakeHub() });
    const onClose = vi.fn();
    const below = vi.fn();
    window.addEventListener("keydown", below);
    render(<BrainDialog title="t" who="Ledger" initial={{ provider: "claude-code", model: "claude-code-mid" }} onUse={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    window.removeEventListener("keydown", below);
    expect(onClose).toHaveBeenCalledOnce();
    expect(below).not.toHaveBeenCalled();
  });
});

describe("Files", () => {
  const agent: Agent = { hubId: "local", id: "ledger", name: "Ledger", model: null, provider: null, isDefault: false };

  it("marks changes unsaved, saves with ⌘S, and discards back to the saved text", async () => {
    const hub = fakeHub();
    useDesk.setState({ hub });
    render(<AgentFiles agent={agent} />);
    const editor = (await screen.findByDisplayValue("# Soul")) as HTMLTextAreaElement;
    expect(screen.getByRole("status").textContent).toBe("Saved");

    fireEvent.change(editor, { target: { value: "# Soul\n\nWatch the bill.\n" } });
    expect(screen.getByRole("status").textContent).toBe("Unsaved changes");
    expect(screen.getAllByLabelText("Unsaved changes")).toHaveLength(1);

    await act(async () => fireEvent.keyDown(editor, { key: "s", metaKey: true }));
    expect(hub.saveIdentityFile).toHaveBeenCalledWith("ledger", "SOUL.md", "# Soul\n\nWatch the bill.\n");
    expect(screen.getByRole("status").textContent).toBe("Saved");
    expect(screen.queryAllByLabelText("Unsaved changes")).toHaveLength(0);

    fireEvent.change(editor, { target: { value: "scrap this" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(editor.value).toBe("# Soul\n\nWatch the bill.\n");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a file's unsaved text while another is open", async () => {
    useDesk.setState({ hub: fakeHub() });
    render(<AgentFiles agent={agent} />);
    const editor = (await screen.findByDisplayValue("# Soul")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: /AGENTS\.md/ }));
    expect(screen.getByRole("status").textContent).toBe("Saved");
    fireEvent.click(screen.getByRole("button", { name: /SOUL\.md/ }));
    expect((screen.getByLabelText("SOUL.md", { selector: "textarea" }) as HTMLTextAreaElement).value).toBe("draft");
  });

  it("says plainly when there's no history to go back to", async () => {
    useDesk.setState({ hub: fakeHub() });
    render(<AgentFiles agent={agent} />);
    await screen.findByDisplayValue("# Soul");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByText(/Earlier versions aren’t kept on this Mac yet/)).toBeTruthy();
  });
});
