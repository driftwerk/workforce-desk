import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import { AgentRoute } from "./RunMyWorkOn";

const fetches = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../hub/net", async (original) => ({
  ...(await original<typeof import("../hub/net")>()),
  pairedHub: () => fetches,
}));

const hub = { id: "pw", url: "https://pw.example" };
const view = (route: unknown) => ({
  available: true,
  route,
  every_agent: null,
  effective: route === "hub" ? null : route,
  options: [{ kind: "claude-code", refused: null }],
});
const answer = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

afterEach(() => {
  cleanup();
  fetches.fetch.mockReset();
});

describe("Choosing what your work with an agent runs on", () => {
  it("reads the agent list again, so what the agent is shown to run on follows", async () => {
    const refreshRoster = vi.fn(() => Promise.resolve());
    useChat.setState({ refreshRoster });
    fetches.fetch.mockResolvedValueOnce(answer(view(null)));
    await act(async () => {
      render(<AgentRoute hub={hub} workspace="Patchwork" agentId="lattice" />);
    });
    expect(refreshRoster).not.toHaveBeenCalled();

    fetches.fetch.mockResolvedValueOnce(answer(view({ kind: "claude-code", fallback: "wait" })));
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: /Claude/ })));

    expect(fetches.fetch).toHaveBeenLastCalledWith("PUT", "/api/me/agents/lattice/llm-route", expect.anything());
    expect(refreshRoster).toHaveBeenCalledTimes(1);
  });
});
