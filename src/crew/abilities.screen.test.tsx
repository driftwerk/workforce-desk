import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import { HubError, type DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { useOverview } from "../overview/store";
import { useUi } from "../shell/ui";
import { useAgentConfigs } from "./agentBrain";
import { AgentSettings } from "./AgentSettings";

vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  invoke: vi.fn(() => Promise.resolve()),
}));

const ledger: Agent = { hubId: "local", id: "ledger", name: "Ledger", model: null, provider: null, isDefault: false };
const local = { id: "local", label: "This Mac", url: "http://127.0.0.1:1", local: true, token: "t" };
const START = `[llm]\nprovider = "claude-code"\n`;

let file = START;
const fakeHub = (over: Partial<DeskHub> = {}): DeskHub =>
  ({
    agentConfig: vi.fn(() => Promise.resolve(file)),
    saveAgentConfig: vi.fn((_id: string, toml: string) => {
      file = toml;
      return Promise.resolve();
    }),
    identityFile: vi.fn(() => Promise.resolve("# Soul\n")),
    identityRevisions: vi.fn(() => Promise.reject(new HubError(503, "revision history requires Postgres"))),
    providers: vi.fn(() => Promise.resolve([])),
    manager: vi.fn(() => Promise.resolve({ agentId: "desk", level: "watch" })),
    memorySummary: vi.fn(() => Promise.resolve({ memories: 214, lessons: 12, tidied_at: new Date(Date.now() - 40 * 60_000).toISOString() })),
    agentHeartbeat: vi.fn(() =>
      Promise.resolve({
        enabled: true,
        interval_secs: 3600,
        quiet_start: null,
        quiet_end: null,
        items: 3,
        last_checked: new Date(Date.now() - 12 * 60_000).toISOString(),
        needed_you: false,
        last_error: null,
      }),
    ),
    ...over,
  }) as unknown as DeskHub;

const doc = () => parse(file) as Record<string, Record<string, unknown>>;

const show = (hub: DeskHub, toml = START, onOpenFiles = () => {}) => {
  file = toml;
  useDesk.setState({ hub });
  useChat.setState({ hubs: [local], roster: [ledger] });
  useAgentConfigs.setState({ configs: { "local/ledger": toml } });
  render(<AgentSettings agent={ledger} hub={local} onOpenFiles={onOpenFiles} />);
};

const section = (name: string) => screen.getByRole("region", { name });
const toggle = (name: string) => screen.getByRole("switch", { name });

beforeEach(() => {
  useOverview.setState({ manager: { agentId: "desk", level: "watch" }, managerSupport: "yes", overviewSupport: "unknown" });
});
afterEach(cleanup);

describe("How they remember", () => {
  it("shows Desk's defaults on, what they remember, and writes a change into this agent's own config", async () => {
    const hub = fakeHub();
    show(hub);
    const remember = section("How they remember");
    expect(await within(remember).findByText("Ledger remembers 214 things and has learned 12 lessons")).toBeTruthy();
    expect(within(remember).getByText("Last tidied 40 minutes ago")).toBeTruthy();
    // No memory browser yet, so no button that pretends to be one.
    expect(within(remember).queryByRole("button", { name: "Review memories" })).toBeNull();
    for (const name of [
      "Remembers what you talk about",
      "Learns from mistakes",
      "Gets better at the work",
      "Tidies their memory",
      "Notices how things are going with you",
    ]) {
      expect(toggle(name).getAttribute("aria-checked")).toBe("true");
    }
    expect(within(remember).queryByRole("button", { name: "Back to Desk’s defaults" })).toBeNull();
    expect(within(remember).getByText(/Memories stay on this Mac/)).toBeTruthy();

    await act(async () => fireEvent.click(toggle("Learns from mistakes")));
    await waitFor(() => expect(doc().memory).toEqual({ lesson_extract: false, lesson_inject: false }));
    expect(vi.mocked(hub.saveAgentConfig).mock.calls[0]![0]).toBe("ledger");
    expect(doc().llm).toEqual({ provider: "claude-code" });
    expect(toggle("Learns from mistakes").getAttribute("aria-checked")).toBe("false");

    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "How often they tidy" }), { target: { value: "86400" } }));
    await waitFor(() => expect(doc().memory).toMatchObject({ consolidation_interval_secs: 86400 }));

    await act(async () => fireEvent.click(within(remember).getByRole("button", { name: "Back to Desk’s defaults" })));
    await waitFor(() => expect(file.trim()).toBe(`[llm]\nprovider = "claude-code"`));
    expect(toggle("Learns from mistakes").getAttribute("aria-checked")).toBe("true");
  });

  it("leaves out what the hub can't tell, and goes back to what the file says when a save fails", async () => {
    const hub = fakeHub({
      memorySummary: vi.fn(() => Promise.reject(new HubError(404, "Not Found"))),
      saveAgentConfig: vi.fn(() => Promise.reject(new HubError(500, "disk full"))),
    });
    show(hub, `${START}\n[memory]\npassive = false\n`);
    expect(toggle("Remembers what you talk about").getAttribute("aria-checked")).toBe("false");
    expect(within(section("How they remember")).getByRole("button", { name: "Back to Desk’s defaults" })).toBeTruthy();
    await act(async () => fireEvent.click(toggle("Remembers what you talk about")));
    await waitFor(() => expect(within(section("How they remember")).getByRole("status").className).toContain("state-blocked"));
    expect(toggle("Remembers what you talk about").getAttribute("aria-checked")).toBe("false");
    expect(within(section("How they remember")).queryByText(/remembers \d/)).toBeNull();
  });
});

describe("How they work", () => {
  it("turns second opinions, claim checks and chained tools off for this agent, and picks how know-how is used", async () => {
    const hub = fakeHub();
    show(hub);
    const work = section("How they work");
    expect(within(work).getByRole("radio", { name: "Learning quietly" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(within(work).getByRole("radio", { name: "Using it" })));
    await waitFor(() => expect(doc().know_how).toEqual({ inject: "on" }));
    expect(within(work).getByText(/collect how-to knowledge from finished work and use it/)).toBeTruthy();
    await act(async () => fireEvent.click(toggle("Checks what they claim")));
    await act(async () => fireEvent.click(toggle("Chains tools together")));
    await waitFor(() => expect(doc().claim_grounding).toEqual({ enabled: false }));
    await waitFor(() => expect(doc().tools).toEqual({ programs: { enabled: false } }));

    await act(async () => fireEvent.change(within(work).getByRole("combobox", { name: "Advisor effort" }), { target: { value: "max" } }));
    await waitFor(() => expect(doc().advisor).toEqual({ cc_effort: "max" }));
    const angles = within(work).getByRole("textbox", { name: "Looks from up to" });
    fireEvent.change(angles, { target: { value: "4" } });
    fireEvent.blur(angles);
    expect(within(work).getByRole("alert").textContent).toMatch(/Use 1 to 3/);
    fireEvent.change(angles, { target: { value: "2" } });
    await act(async () => fireEvent.keyDown(angles, { key: "Enter" }));
    await waitFor(() => expect(doc().advisor).toEqual({ cc_effort: "max", fanout: { max_lenses: 2, max_concurrent: 2 } }));

    await act(async () => fireEvent.click(toggle("Asks for a second opinion")));
    await waitFor(() => expect(doc().advisor).toMatchObject({ enabled: false }));
    expect(within(work).queryByRole("combobox", { name: "Advisor effort" })).toBeNull();
  });
});

describe("Checking in", () => {
  it("is off until turned on, then says how often, its quiet hours and how its list went", async () => {
    const opened = vi.fn();
    const hub = fakeHub();
    show(hub, START, opened);
    const checkin = section("Checking in");
    expect(toggle("Checks in on their own").getAttribute("aria-checked")).toBe("false");
    expect(within(checkin).queryByRole("button", { name: "Edit the check-in list" })).toBeNull();
    await act(async () => fireEvent.click(toggle("Checks in on their own")));
    await waitFor(() => expect(doc().heartbeat).toEqual({ enabled: true }));
    expect(await within(checkin).findByText("3 things on it · last checked 12 minutes ago, nothing needed you")).toBeTruthy();

    const from = within(checkin).getByRole("textbox", { name: "Quiet from" });
    fireEvent.change(from, { target: { value: "22:00" } });
    fireEvent.blur(from);
    expect(within(checkin).getByRole("alert").textContent).toBe("Give both times, or neither for no quiet hours.");
    const to = within(checkin).getByRole("textbox", { name: "Quiet until" });
    fireEvent.change(to, { target: { value: "7:00" } });
    await act(async () => fireEvent.keyDown(to, { key: "Enter" }));
    await waitFor(() => expect(doc().heartbeat).toEqual({ enabled: true, quiet_start: "22:00", quiet_end: "07:00" }));

    await act(async () => fireEvent.change(within(checkin).getByRole("combobox", { name: "How often they check in" }), { target: { value: "900" } }));
    await waitFor(() => expect(doc().heartbeat).toMatchObject({ interval_secs: 900 }));

    fireEvent.click(within(checkin).getByRole("button", { name: "Edit the check-in list" }));
    expect(opened).toHaveBeenCalled();
    expect(useUi.getState().agentFiles["local/ledger"]).toBe("HEARTBEAT.md");
  });
});

describe("The Settings tab", () => {
  it("links to each section, and its fine-tuning names the check-in list", () => {
    show(fakeHub());
    const links = within(screen.getByRole("navigation", { name: "Sections" })).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "About",
      "How they think",
      "How they sound",
      "How they remember",
      "How they work",
      "Checking in",
      "Fine-tuning",
    ]);
    expect(screen.getByText("Soul, Agents, Identity, Welcome and Heartbeat")).toBeTruthy();
  });
});
