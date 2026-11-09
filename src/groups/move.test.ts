// The one way a sidebar row moves between groups: what moves at once, and
// what is asked about first (and never moved meanwhile).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../chat/store";
import type { Agent } from "../chat/types";
import type { Manager } from "../hub/types";
import { useOverview } from "../overview/store";
import { useHubLayout } from "./hubLayout";
import { EMPTY_LAYOUT, type Layout } from "./model";
import { moveRow, useMove } from "./move";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const LAYOUT: Layout = {
  groups: [
    { id: "acme", name: "Acme", collapsed: false, items: ["session:s1", "agent:local/scout"] },
    { id: "personal", name: "Personal", collapsed: false, items: [] },
  ],
  ungrouped: EMPTY_LAYOUT.ungrouped,
};
const MANAGER: Manager = { agentId: "desk", level: "act", bosses: [{ agentId: "sarah", name: "Sarah", group: "acme", level: "act" }], sealed: [] };
const scout: Agent = { hubId: "local", id: "scout", name: "Scout", model: null, provider: null, isDefault: false };
const LOCAL = { id: "local", label: "This computer", url: "http://local.test", local: true, revision: "t" };

let fetched: string[];
beforeEach(() => {
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      fetched.push(String(input));
      return new Response("Not Found", { status: 404 });
    }),
  );
  useHubLayout.setState({ layout: LAYOUT, kept: true });
  useOverview.setState({ manager: MANAGER });
  useChat.setState({ hubs: [LOCAL] });
  useMove.setState({ asking: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("moving a row", () => {
  it("asks, moving nothing, when the hub keeps the groups but can't be reached as the person", async () => {
    useChat.setState({ hubs: [] });
    const layout = vi.fn();
    await moveRow({ kind: "session", id: "s1", name: "acme-docs", from: "acme" }, "personal", layout);
    expect(layout).not.toHaveBeenCalled();
    expect(fetched).toEqual([]);
    expect(useMove.getState().asking).toMatchObject({ subject: { kind: "session", id: "s1" }, to: "personal" });
    expect(useMove.getState().asking?.preview).toBeUndefined();
  });

  it("moves at once when no hub keeps the groups", async () => {
    useHubLayout.setState({ layout: null });
    useChat.setState({ hubs: [] });
    const layout = vi.fn();
    await moveRow({ kind: "session", id: "s1", name: "acme-docs", from: "acme" }, "personal", layout);
    expect(layout).toHaveBeenCalledOnce();
    expect(useMove.getState().asking).toBeNull();
  });

  it("asks before moving an agent's row while Desk doesn't know who oversees what", async () => {
    useOverview.setState({ manager: null });
    const layout = vi.fn();
    await moveRow({ kind: "agent", agent: scout, name: "Scout", from: "personal" }, "ungrouped", layout);
    expect(layout).not.toHaveBeenCalled();
    expect(useMove.getState().asking?.subject.kind).toBe("agent");
  });

  it("moves an agent's row at once within one boss's part, and asks across", async () => {
    const layout = vi.fn();
    await moveRow({ kind: "agent", agent: scout, name: "Scout", from: "personal" }, "ungrouped", layout);
    expect(layout).toHaveBeenCalledOnce();
    await moveRow({ kind: "agent", agent: scout, name: "Scout", from: "acme" }, "personal", layout);
    expect(layout).toHaveBeenCalledOnce();
    expect(useMove.getState().asking).toMatchObject({ subject: { kind: "agent" }, to: "personal" });
  });

  it("asks when a preview fails, an old hub's 404 included", async () => {
    const layout = vi.fn();
    await moveRow({ kind: "session", id: "s1", name: "acme-docs", from: "acme" }, "personal", layout);
    expect(fetched).toEqual(["http://local.test/api/desk/moves/preview"]);
    expect(layout).not.toHaveBeenCalled();
    expect(useMove.getState().asking?.subject.kind).toBe("session");
  });
});
