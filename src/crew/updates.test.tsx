import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../chat/types";
import { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import { useUi } from "../shell/ui";
import { useAgentConfigs } from "./agentBrain";
import { UpdatesCard, UpdatesSettings } from "./Updates";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emitTo: vi.fn(() => Promise.resolve()),
}));

const BOSS = { id: "desk", hubId: "local", name: "Desk" } as Agent;
let config: string;
let asked: { method: string; path: string; text?: string }[];
/** Holds each config write until released, when set. */
let held: (() => void)[] | null = null;

const transport: DeskTransport = {
  fetch: async (method, path, body) => {
    asked.push({ method, path, text: body ? String(body.data) : undefined });
    if (path.endsWith("/config") && method === "PUT") {
      if (held) await new Promise<void>((go) => held!.push(go));
      config = String(body!.data);
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/config")) return new Response(config, { status: 200 });
    if (path === "/api/desk/updates/desk") return Response.json({ nextRoundup: "2026-11-16T10:00:00Z" });
    if (path === "/api/desk/updates/desk/roundup") return new Response(null, { status: 204 });
    return new Response("{}", { status: 404 });
  },
  socket: () => ({}) as DeskSocket,
};

beforeEach(() => {
  held = null;
  asked = [];
  config = '[oversight]\nenabled = true\nlevel = "full"\n';
  useAgentConfigs.setState({ configs: { "local/desk": config } });
  useDesk.setState({ hub: new DeskHub(transport) });
});
afterEach(() => {
  cleanup();
  useDesk.setState({ hub: null });
});

describe("the Updates card beside the boss's chat", () => {
  it("says what it does now and when the next roundup comes", async () => {
    render(<UpdatesCard agent={BOSS} />);
    expect(screen.getByRole("radio", { name: "Balanced" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Right away:")).toBeTruthy();
    expect(await screen.findByText(/Next roundup \d\d:\d\d/)).toBeTruthy();
  });

  it("writes a preset to the boss's config, keeping the rest", async () => {
    render(<UpdatesCard agent={BOSS} />);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Roundups only" })));
    await vi.waitFor(() => expect(config).toContain('problems = "roundup"'));
    expect(config).toContain('level = "full"');
    expect(screen.getByRole("radio", { name: "Roundups only" }).getAttribute("aria-checked")).toBe("true");
  });

  it("asks for a roundup now, and opens the settings in full", async () => {
    render(<UpdatesCard agent={BOSS} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Roundup now" })));
    expect(asked.some((a) => a.method === "POST" && a.path === "/api/desk/updates/desk/roundup")).toBe(true);
    expect(await screen.findByText("It’s on its way.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    expect(useUi.getState().agentTabs["local/desk"]).toBe("settings");
  });

  it("isn't shown for an agent that doesn't oversee", () => {
    useAgentConfigs.setState({ configs: { "local/desk": "" } });
    const { container } = render(<UpdatesCard agent={BOSS} />);
    expect(container.textContent).toBe("");
  });
});

describe("Settings › Updates", () => {
  it("keeps two quick changes on screen while the first is still being written", async () => {
    held = [];
    render(<UpdatesSettings agent={BOSS} />);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Finished: Right away" })));
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Every 2 hours" })));
    expect((screen.getByRole("radio", { name: "Finished: Right away" }) as HTMLInputElement).checked).toBe(true);
    // The first write lands: the second change stays shown.
    await vi.waitFor(() => expect(held!.length).toBe(1));
    await act(async () => held!.shift()!());
    expect((screen.getByRole("radio", { name: "Every 2 hours" }) as HTMLInputElement).checked).toBe(true);
    await vi.waitFor(() => expect(held!.length).toBe(1));
    await act(async () => held!.shift()!());
    await vi.waitFor(() => expect(config).toContain('roundup = "2h"'));
    expect(config).toContain('finished = "right_away"');
    expect(screen.getByRole("status").textContent).toBe("Saved.");
  });

  it("won't hold news for roundups that never come, and says why", async () => {
    render(<UpdatesSettings agent={BOSS} />);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Never — only right-away items" })));
    expect((await screen.findByRole("alert")).textContent).toMatch(/With no roundups, finished work and progress would never be told/);
    expect((screen.getByRole("radio", { name: "Every hour" }) as HTMLInputElement).checked).toBe(true);
    expect(asked.some((a) => a.method === "PUT")).toBe(false);
  });

  it("says when the file holds what the hub won't take", () => {
    useAgentConfigs.setState({ configs: { "local/desk": '[oversight]\nenabled = true\n\n[oversight.updates]\nroundup = "5m"\n' } });
    render(<UpdatesSettings agent={BOSS} />);
    expect(screen.getByRole("alert").textContent).toMatch(/How often the roundup comes must be .* isn’t overseeing anything/);
  });
});
