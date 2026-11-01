import { afterEach, describe, expect, it, vi } from "vitest";
import { useChat } from "./store";
import type { HubAccount } from "./types";

/** The DMs opened: the hub each was opened on, and whether it's closed. */
const opened = vi.hoisted(() => [] as { hub: { revision: string }; agent: string; closed: boolean }[]);

vi.mock("./conversation", async (original) => ({
  ...(await original<typeof import("./conversation")>()),
  Conversation: class {
    closed = false;
    constructor(
      readonly hub: { revision: string },
      readonly agent: string,
    ) {
      opened.push(this);
    }
    close() {
      this.closed = true;
    }
  },
}));

const acme: HubAccount = { id: "hub-example-com", label: "Acme", url: "https://hub.example.com", local: false, revision: "wfp_old" };

afterEach(() => vi.unstubAllGlobals());

describe("a workspace paired again", () => {
  it("keeps its DMs, now spoken to as the new pairing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: URL) =>
        new URL(u).pathname === "/api/agents"
          ? new Response(JSON.stringify({ agents: [{ id: "scout", name: "Scout" }] }), {
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ messages: [], more: false }), { headers: { "content-type": "application/json" } }),
      ),
    );
    useChat.getState().setHubs([acme]);
    await vi.waitFor(() => expect(useChat.getState().roster).toHaveLength(1));
    useChat.getState().openDm("hub-example-com/scout");
    const first = opened.at(-1)!;
    expect(first.hub.revision).toBe("wfp_old");

    // Same id, label and address; only the token (so its revision) is new.
    useChat.getState().setHubs([{ ...acme, revision: "wfp_new" }]);
    expect(first.closed).toBe(true);
    const again = opened.at(-1)!;
    expect(again).not.toBe(first);
    expect(again.hub.revision).toBe("wfp_new");
    expect(again.agent).toBe("scout");
    expect(useChat.getState().activeAgent).toBe("hub-example-com/scout");

    // Nothing changed: nothing reopened.
    useChat.getState().setHubs([{ ...acme, revision: "wfp_new" }]);
    expect(opened.at(-1)).toBe(again);
    expect(again.closed).toBe(false);
  });
});
