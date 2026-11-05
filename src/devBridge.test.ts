import { describe, expect, it } from "vitest";
import { devHub } from "./devBridge";
import { engineListeners, type EngineEvent } from "./hub/store";

describe("the preview's crew", () => {
  it("announces what it records as this computer's engine does, so History hears it live", async () => {
    const heard: EngineEvent[] = [];
    const listen = (e: EngineEvent) => void heard.push(e);
    engineListeners.add(listen);
    try {
      const { suggestions } = await devHub<{ suggestions: { id: string; state: string }[] }>("GET", "/api/desk/suggestions");
      const open = suggestions.find((s) => s.state === "open")!;
      await devHub("POST", `/api/desk/suggestions/${encodeURIComponent(open.id)}/dismiss`);
      expect(heard.map((e) => e.type)).toContain("activity");
    } finally {
      engineListeners.delete(listen);
    }
  });
});
