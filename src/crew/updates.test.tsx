import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../chat/types";
import { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import type { DeskSocket, DeskTransport } from "../hub/transport";
import { useUi } from "../shell/ui";
import { useAgentConfigs } from "./agentBrain";
import { UpdatesCard } from "./Updates";

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

const transport: DeskTransport = {
  fetch: async (method, path, body) => {
    asked.push({ method, path, text: body ? String(body.data) : undefined });
    if (path.endsWith("/config") && method === "PUT") {
      config = String(body!.data);
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/config")) return new Response(config, { status: 200 });
    if (path === "/api/desk/updates/desk")
      return Response.json({ nextRoundup: "2026-11-16T10:00:00Z" });
    if (path === "/api/desk/updates/desk/roundup")
      return new Response(null, { status: 204 });
    return new Response("{}", { status: 404 });
  },
  socket: () => ({}) as DeskSocket,
};

beforeEach(() => {
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
    expect(
      screen
        .getByRole("radio", { name: "Balanced" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("Right away:")).toBeTruthy();
    expect(await screen.findByText(/Next roundup \d\d:\d\d/)).toBeTruthy();
  });

  it("writes a preset to the boss's config, keeping the rest", async () => {
    render(<UpdatesCard agent={BOSS} />);
    await act(async () =>
      fireEvent.click(screen.getByRole("radio", { name: "Roundups only" })),
    );
    await vi.waitFor(() => expect(config).toContain('problems = "roundup"'));
    expect(config).toContain('level = "full"');
    expect(
      screen
        .getByRole("radio", { name: "Roundups only" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("asks for a roundup now, and opens the settings in full", async () => {
    render(<UpdatesCard agent={BOSS} />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Roundup now" })),
    );
    expect(
      asked.some(
        (a) =>
          a.method === "POST" && a.path === "/api/desk/updates/desk/roundup",
      ),
    ).toBe(true);
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
