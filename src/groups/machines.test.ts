import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({}));

const { useDesk } = await import("../hub/store");
const { groupable, nameSession } = await import("./store");

describe("a machine's sessions and this computer's groups", () => {
  it("keeps a machine's sessions out: groups don't mix machines", () => {
    expect(groupable("session:s1")).toBe(true);
    expect(groupable("agent:local/desk")).toBe(true);
    expect(groupable("session:devbox/s1")).toBe(false);
  });

  it("names a machine's session on its own engine, stamped with its machine", async () => {
    const mine = { nameSession: vi.fn() };
    const theirs = { nameSession: vi.fn(async (id: string, name: string) => ({ id, name: "web", displayName: name })) };
    useDesk.setState({
      hub: mine as never,
      engines: { devbox: { hub: theirs as never, connected: true, loaded: true, error: null } },
      sessions: { "devbox/s1": { id: "s1", name: "web", machine: "devbox" } as never },
    });
    nameSession("devbox/s1", "Checkout", "web");
    await vi.waitFor(() => expect(useDesk.getState().sessions["devbox/s1"]?.displayName).toBe("Checkout"));
    expect(theirs.nameSession).toHaveBeenCalledWith("s1", "Checkout");
    expect(mine.nameSession).not.toHaveBeenCalled();
    expect(useDesk.getState().sessions["devbox/s1"]?.machine).toBe("devbox");
    useDesk.setState({ hub: null, engines: {}, sessions: {} });
  });
});
