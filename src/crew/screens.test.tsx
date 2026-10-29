import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../chat/types";
import { HubError, type DeskHub } from "../hub/client";
import type { Provider } from "../hub/providers";
import { useDesk } from "../hub/store";
import { BrainDialog } from "../providers/BrainDialog";
import { useProviders } from "../providers/store";
import { useChat } from "../chat/store";
import { AgentFiles } from "./AgentFiles";
import { AgentSettings } from "./AgentSettings";
import { useDrafts } from "./files";
import { useSettings } from "../settings/store";

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
    providers: vi.fn(() => Promise.resolve(useProviders.getState().providers)),
    memorySummary: vi.fn(() => Promise.reject(new HubError(404, "Not Found"))),
    agentHeartbeat: vi.fn(() => Promise.reject(new HubError(404, "Not Found"))),
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

  it("hides the effort for a model without one, and re-checks it when the model changes", async () => {
    useDesk.setState({ hub: fakeHub() });
    const claude = plan("claude-code", "Claude plan", true);
    useProviders.setState({
      providers: [
        {
          ...claude,
          models: [
            { id: "deep", name: "Deep", description: "", default: true, efforts: ["high", "max"], defaultEffort: "high" },
            { id: "quick", name: "Quick", description: "", default: false, efforts: [] },
          ],
        },
      ],
    });
    const onUse = vi.fn();
    render(
      <BrainDialog title="How Ledger thinks" who="Ledger" initial={{ provider: "claude-code", model: "deep", effort: "max" }} onUse={onUse} onClose={() => {}} />,
    );
    expect(screen.getByRole("radio", { name: "Max" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("radio", { name: "Low" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Quick/ }));
    expect(screen.queryByRole("radiogroup", { name: "Effort" })).toBeNull();
    expect(screen.getByText("Ledger will use Quick on your Claude plan")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Deep/ }));
    expect(screen.getByRole("radio", { name: "High" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /Quick/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use this" })));
    expect(onUse).toHaveBeenCalledWith({ provider: "claude-code", model: "quick" });
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

    await act(async () => fireEvent.keyDown(editor, { key: "s", code: "KeyS", metaKey: true }));
    expect(hub.saveIdentityFile).toHaveBeenCalledWith("ledger", "SOUL.md", "# Soul\n\nWatch the bill.\n");
    expect(screen.getByRole("status").textContent).toBe("Saved");
    expect(screen.queryAllByLabelText("Unsaved changes")).toHaveLength(0);

    fireEvent.change(editor, { target: { value: "scrap this" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(editor.value).toBe("# Soul\n\nWatch the bill.\n");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves with the configured keys, and says which", async () => {
    const hub = fakeHub();
    useDesk.setState({ hub });
    useSettings.getState().setShortcut("saveFile", "Control+Alt+S");
    render(<AgentFiles agent={agent} />);
    const editor = (await screen.findByDisplayValue("# Soul")) as HTMLTextAreaElement;
    expect(screen.getByText("⌃⌥S")).toBeTruthy();
    fireEvent.change(editor, { target: { value: "# Soul\n\nNew.\n" } });
    await act(async () => fireEvent.keyDown(editor, { key: "s", code: "KeyS", metaKey: true }));
    expect(hub.saveIdentityFile).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(editor, { key: "ß", code: "KeyS", ctrlKey: true, altKey: true }));
    expect(hub.saveIdentityFile).toHaveBeenCalledWith("ledger", "SOUL.md", "# Soul\n\nNew.\n");
    useSettings.getState().setShortcut("saveFile", "Super+S");
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

describe("Renaming in Settings", () => {
  const agent: Agent = { hubId: "local", id: "ledger", name: "Ledger", model: null, provider: null, isDefault: false };
  const local = { id: "local", label: "This Mac", url: "http://127.0.0.1:1", local: true, token: "t" };

  const renderSettings = (hub: DeskHub) => {
    useDesk.setState({ hub });
    useChat.setState({ hubs: [local], roster: [agent], refreshRoster: vi.fn(() => Promise.resolve()) });
    const view = () => render(<AgentSettings agent={useChat.getState().roster[0]!} hub={local} onOpenFiles={() => {}} />);
    return view();
  };

  it("renames at once everywhere the roster shows it", async () => {
    let finish: () => void = () => {};
    const hub = fakeHub({ renameAgent: vi.fn(() => new Promise<void>((r) => (finish = r))) } as Partial<DeskHub>);
    renderSettings(hub);
    const name = (await screen.findByDisplayValue("Ledger")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Penny" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(useChat.getState().roster[0]!.name).toBe("Penny");
    await waitFor(() => expect(hub.renameAgent).toHaveBeenCalled());
    await act(async () => finish());
    await waitFor(() => expect(screen.getByText("Saved into their files.")).toBeTruthy());
    expect(vi.mocked(hub.renameAgent).mock.calls[0]?.slice(0, 2)).toEqual(["ledger", "Penny"]);
    expect(useChat.getState().roster[0]!.name).toBe("Penny");
  });

  it("puts the name back and says why when the hub can't rename yet", async () => {
    const hub = fakeHub({ renameAgent: vi.fn(() => Promise.reject(new HubError(405, "Method Not Allowed"))) } as Partial<DeskHub>);
    renderSettings(hub);
    const name = (await screen.findByDisplayValue("Ledger")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Penny" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(await screen.findByText(/Renaming isn’t available yet/)).toBeTruthy();
    expect(useChat.getState().roster[0]!.name).toBe("Ledger");
    expect(hub.saveIdentityFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(name.value).toBe("Ledger");
  });

  it("keeps the new name when only their files couldn't be updated, and says so", async () => {
    const hub = fakeHub({
      renameAgent: vi.fn(() => Promise.resolve({})),
      saveIdentityFile: vi.fn(() => Promise.reject(new HubError(500, "disk full"))),
    } as Partial<DeskHub>);
    renderSettings(hub);
    const name = (await screen.findByDisplayValue("Ledger")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Penny" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(await screen.findByText(/Renamed, but their files still say Ledger/)).toBeTruthy();
    expect(useChat.getState().roster[0]!.name).toBe("Penny");
    expect(name.value).toBe("Penny");
  });
});
