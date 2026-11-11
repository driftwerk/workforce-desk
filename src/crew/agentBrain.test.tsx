import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../chat/types";
import type { DeskHub } from "../hub/client";
import { useDesk } from "../hub/store";
import { useProviders } from "../providers/store";
import { useAgentBrain } from "./agentBrain";

describe("an agent's brain", () => {
  beforeEach(() => {
    useProviders.setState({ providers: [], fallback: false, loaded: true, loading: false, problem: null });
  });

  it("asks the hub for the providers again each time it is opened, though they were loaded", async () => {
    const providers = vi.fn().mockResolvedValue([]);
    useDesk.setState({ hub: { providers, agentConfig: () => Promise.resolve("") } as unknown as DeskHub });
    const agent = { id: "a1", name: "Atlas", provider: "claude-code", model: "sonnet" } as unknown as Agent;
    renderHook(() => useAgentBrain(agent, true));
    await waitFor(() => expect(providers).toHaveBeenCalledTimes(1));
  });
});
