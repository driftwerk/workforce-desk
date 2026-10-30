import { describe, expect, it } from "vitest";
import { countsByItem, itemKeyOf, nameOf, turnAgentOf } from "./needs";
import { agent, session } from "./testing";

describe("the needs index", () => {
  it("keys this computer's sessions by id, another hub's by its hub, and agents by hub", () => {
    expect(itemKeyOf({ hubId: "local", local: true, who: session("s-1") })).toBe("session:s-1");
    expect(itemKeyOf({ hubId: "b", local: false, who: session("s-1") })).toBe("session:b/s-1");
    expect(itemKeyOf({ hubId: "b", local: false, who: agent("scout") })).toBe("agent:b/scout");
  });

  it("calls this computer's sessions by the names given them, and no other hub's", () => {
    const names = { "s-1": "date picker" };
    expect(nameOf({ local: true, who: session("s-1", "web") }, names)).toBe("date picker");
    expect(nameOf({ local: false, who: session("s-1", "web") }, names)).toBe("web");
    expect(nameOf({ local: true, who: agent("s-1", "Scout") }, names)).toBe("Scout");
  });

  it("calls what the hub sent no name to read by what it is", () => {
    expect(nameOf({ local: false, who: session("6f1c2a9e-3b7d-4c55-9a0e-1d2b3c4d5e6f", "at-dm-d4774cbb6c89-2e") }, {})).toBe("Agent turn");
    expect(nameOf({ local: true, who: session("6f1c2a9e-3b7d-4c55-9a0e-1d2b3c4d5e6f", "6f1c2a9e-3b7d-4c55-9a0e-1d2b3c4d5e6f") }, {})).toBe("Claude Code session");
    expect(nameOf({ local: true, who: { ...session("s-1", " "), engine: "codex" } }, {})).toBe("Codex session");
    expect(nameOf({ local: true, who: agent("scout", "") }, {})).toBe("Agent");
    expect(nameOf({ local: true, who: agent("scout") }, {})).toBe("scout");
  });

  it("knows an agent's turn by the folder it ran in", () => {
    expect(turnAgentOf("/data/agents/scout/projects/_agent-turn/work/session/at-dm-d4774cbb6c89")).toBe("scout");
    expect(turnAgentOf("/fast/work/scout/_agent-turn/session/at-dm-d4774cbb6c89")).toBe("scout");
    expect(turnAgentOf("C:\\desk\\agents\\scout\\projects\\_agent-turn\\work\\session\\at-ses-0a1b2c3d4e5f")).toBe("scout");
    expect(turnAgentOf("/Users/me/code/at-dm-d4774cbb6c89")).toBeNull();
    expect(turnAgentOf("/data/agents/scout/projects/web/work/session/x")).toBeNull();
  });

  it("counts needs per item, the same agent on two hubs apart", () => {
    const counts = countsByItem([
      { hubId: "local", local: true, who: session("s-1") },
      { hubId: "local", local: true, who: session("s-1") },
      { hubId: "local", local: true, who: agent("scout") },
      { hubId: "b", local: false, who: agent("scout") },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ "session:s-1": 2, "agent:local/scout": 1, "agent:b/scout": 1 });
  });
});
