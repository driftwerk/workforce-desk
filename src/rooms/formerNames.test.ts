import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../chat/types";
import { resolveMentions, setFormerly } from "./mentions";
import { withFormerName } from "./formerNames";

const agent = (hubId: string, id: string, name: string): Agent => ({ hubId, id, name, model: null, provider: null, isDefault: false });

afterEach(() => setFormerly(() => []));

describe("A name an agent had before a rename", () => {
  const lookout = agent("local", "scout", "Lookout");
  const pathfinder = agent("local", "pathfinder", "Pathfinder");
  const roster = [lookout, pathfinder, agent("local", "atlas", "Atlas")];
  const before: Record<string, string[]> = { "local/scout": ["Ranger", "Pathfinder"] };
  const formerly = (a: Agent) => before[`${a.hubId}/${a.id}`] ?? [];

  it("still reaches them, in the room and from outside it", () => {
    setFormerly(formerly);
    expect(resolveMentions("@ranger ready?", [{ hub: "local", agent: "scout" }], roster).members).toEqual([{ hub: "local", agent: "scout" }]);
    expect(resolveMentions("@ranger ready?", [], roster).outsiders).toEqual([lookout]);
    expect(resolveMentions("@lookout ready?", [], roster).outsiders).toEqual([lookout]);
  });

  it("goes to the agent who has it now, when one does", () => {
    setFormerly(formerly);
    expect(resolveMentions("@pathfinder ready?", [{ hub: "local", agent: "scout" }], roster)).toEqual({ members: [], outsiders: [pathfinder], ambiguous: [] });
  });
});

describe("Keeping a former name", () => {
  it("keeps it newest first, once, never the name they have now, and only a few", () => {
    let kept = withFormerName({}, "local/scout", "Scout", "Ranger");
    kept = withFormerName(kept, "local/scout", "Ranger", "Scout");
    expect(kept["local/scout"]).toEqual(["Ranger"]);
    for (const [was, now] of [["Scout", "A"], ["A", "B"], ["B", "C"], ["C", "D"], ["D", "E"]]) kept = withFormerName(kept, "local/scout", was!, now!);
    expect(kept["local/scout"]).toEqual(["D", "C", "B", "A", "Scout"]);
  });

  it("is noted when the hub lists an agent under a new name, not when Desk only shows one", async () => {
    vi.resetModules();
    const { useChat } = await import("../chat/store");
    const { useSettings } = await import("../settings/store");
    const { rememberFormerNames } = await import("./formerNames");
    rememberFormerNames();
    const listed = { name: "Scout" };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ agents: [{ id: "scout", name: listed.name }] })));
    try {
      useChat.setState({ hubs: [{ id: "local", label: "This computer", url: "http://127.0.0.1:1", local: true, revision: "t" }], roster: [] });
      await useChat.getState().refreshRoster();
      useChat.getState().rename("local/scout", "Ghost");
      await useChat.getState().refreshRoster();
      expect(useSettings.getState().formerNames).toEqual({});
      listed.name = "Lookout";
      await useChat.getState().refreshRoster();
      expect(useSettings.getState().formerNames).toEqual({ "local/scout": ["Scout"] });
    } finally {
      fetch.mockRestore();
    }
  });
});
