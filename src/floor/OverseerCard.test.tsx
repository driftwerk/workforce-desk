import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { useOverview } from "../overview/store";
import { OverseerCard } from "./OverseerCard";

vi.mock("../platform", async (real) => ({
  ...(await real<typeof import("../platform")>()),
  repoFacts: vi.fn(() =>
    Promise.resolve([{ folder: "/w/acme-web", top: "/r/acme-web", remote: "git@github.com:acme/acme-web.git", workflows: ["deploy.yml"] }]),
  ),
}));

const desk: Agent = { hubId: "local", id: "desk", name: "Desk", model: null, provider: null, isDefault: true };
const ledger: Agent = { hubId: "local", id: "ledger", name: "Ledger", model: null, provider: null, isDefault: false };

let files: Record<string, string> = {};
const fakeHub = () =>
  ({
    agentConfig: vi.fn((id: string) => Promise.resolve(files[id] ?? "")),
    saveAgentConfig: vi.fn((id: string, toml: string) => {
      files[id] = toml;
      return Promise.resolve();
    }),
    manager: vi.fn(() => Promise.resolve({ agentId: Object.keys(files)[0] ?? null, level: "act" })),
    overview: vi.fn(() => Promise.resolve({ brief: null, counts: { working: 0, needsYou: 0, doneToday: 0 }, items: [] })),
    spend: vi.fn(() => Promise.resolve(null)),
  }) as unknown as DeskHub;

const oversight = (id: string) => (parse(files[id] ?? "") as { oversight?: Record<string, unknown> }).oversight;

beforeEach(() => {
  files = {};
  localStorage.clear();
  useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }], roster: [ledger, desk] });
  useOverview.setState({ manager: { agentId: null, level: null }, managerSupport: "yes", overviewSupport: "unknown" });
  useDesk.setState({ sessions: {} });
});
afterEach(cleanup);

describe("Who oversees the crew, on the Floor", () => {
  it("asks only while no one oversees, with the default agent picked, and Act writes Act's switches once", async () => {
    const hub = fakeHub();
    useDesk.setState({ hub });
    render(<OverseerCard />);
    expect(screen.getByRole("heading", { name: "No one oversees your crew" })).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("desk");
    const levels = within(screen.getByRole("radiogroup")).getAllByRole("radio").map((r) => r.querySelector("b")?.textContent);
    expect(levels).toEqual(["Watch", "Suggest", "Act", "Act fully", "Unbound"]);
    expect(screen.getByRole("radio", { name: /^Act ?Does/ }).getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Desk oversees at Act" })));
    await waitFor(() => expect(hub.saveAgentConfig).toHaveBeenCalledTimes(1));
    expect(oversight("desk")).toMatchObject({
      enabled: true,
      level: "act",
      act: { hand_out_work: true, interrupt: true, read_only_approvals: true, message_agents: false, set_mode: false },
    });
    expect("group" in oversight("desk")!).toBe(false);
    // The hub now names an overseer: the card goes.
    await waitFor(() => expect(screen.queryByRole("heading", { name: "No one oversees your crew" })).toBeNull());
  });

  it("isn't shown while someone oversees, without an agent, or once put off", () => {
    useDesk.setState({ hub: fakeHub() });
    useOverview.setState({ manager: { agentId: "ledger", level: "act" } });
    const { unmount } = render(<OverseerCard />);
    expect(screen.queryByRole("heading", { name: "No one oversees your crew" })).toBeNull();
    unmount();
    useOverview.setState({ manager: { agentId: null, level: null } });
    useChat.setState({ roster: [] });
    render(<OverseerCard />);
    expect(screen.queryByRole("heading", { name: "No one oversees your crew" })).toBeNull();
    cleanup();
    useChat.setState({ roster: [desk] });
    render(<OverseerCard />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("heading", { name: "No one oversees your crew" })).toBeNull();
    cleanup();
    render(<OverseerCard />);
    expect(screen.queryByRole("heading", { name: "No one oversees your crew" })).toBeNull();
  });

  it("sets Act fully up from what Desk finds, before writing anything, and leaves nothing missing", async () => {
    const hub = fakeHub();
    useDesk.setState({ hub });
    render(<OverseerCard />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ledger" } });
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /^Act fully/ })));
    const repos = await screen.findByRole("list", { name: "Repos it acts fully in" });
    expect((within(repos).getByRole("checkbox", { name: "acme/acme-web" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "deploy.yml" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("textbox", { name: /Daily budget/ }) as HTMLInputElement).value).toBe("10");
    expect(screen.getByText(/Nothing this week was billed to an API key or a cloud account/)).toBeTruthy();
    expect(hub.saveAgentConfig).not.toHaveBeenCalled();
    // Another typed in, the suggested workflow left out.
    fireEvent.change(screen.getByRole("textbox", { name: "Add a repo" }), { target: { value: "acme/acme-api" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "deploy.yml" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ledger oversees at Act fully" })));
    await waitFor(() => expect(hub.saveAgentConfig).toHaveBeenCalledTimes(1));
    expect(oversight("ledger")).toMatchObject({
      level: "full",
      act: { hand_out_work: true, set_mode: false },
      full: { anywhere: false, repos: ["acme/acme-web", "acme/acme-api"], workflows: [], budget_usd_per_day: 10 },
    });
  });

  it("won't set Act fully without a repo or with a wrong budget, and Unbound turns every switch on", async () => {
    const platform = await import("../platform");
    (platform.repoFacts as ReturnType<typeof vi.fn>).mockImplementationOnce(() => Promise.resolve([]));
    const hub = fakeHub();
    useDesk.setState({ hub });
    render(<OverseerCard />);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /^Act fully/ })));
    expect(await screen.findByText("Desk found no repos in your sessions’ folders.")).toBeTruthy();
    const go = screen.getByRole("button", { name: "Desk oversees at Act fully" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Add a repo" }), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("Name a repo as owner/name, its address, or a folder like ~/dev/acme-web.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /Daily budget/ }), { target: { value: "0" } });
    expect(screen.getByText(/Its daily budget must be an amount in dollars above 0/)).toBeTruthy();
    // Unbound: the budget optional, every switch on, anywhere.
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /^Unbound/ })));
    fireEvent.change(screen.getByRole("textbox", { name: /Daily budget/ }), { target: { value: "" } });
    expect(screen.getByText(/No limits: it does everything itself/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Desk oversees at Unbound" })));
    await waitFor(() => expect(hub.saveAgentConfig).toHaveBeenCalledTimes(1));
    const o = oversight("desk")!;
    expect(o).toMatchObject({ level: "full", full: { anywhere: true } });
    expect(Object.values(o.act as Record<string, boolean>).every(Boolean)).toBe(true);
    expect("budget_usd_per_day" in (o.full as object)).toBe(false);
  });
});
