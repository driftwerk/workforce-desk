import { describe, expect, it, vi } from "vitest";
import type { DeskHub } from "../hub/client";
import { withWelcome } from "./local";
import { adoptDeskWelcome, DESK_WELCOME, isHubWelcome, withDeskWelcome } from "./welcome";

const HUB =
  "Read your IDENTITY.md and SOUL.md to know who you are.\n" +
  "If the memory/ directory has any files, briefly mention what's in progress.\n" +
  "If memory/ is empty, just introduce yourself based on your identity.\n" +
  "Keep it to 2-3 sentences. Don't mention or apologise about empty files.\n";

describe("Desk's welcome", () => {
  it("replaces the hub's, keeping Desk's greeting line", () => {
    expect(withDeskWelcome(HUB)).toBe(DESK_WELCOME);
    expect(withDeskWelcome("")).toBe(DESK_WELCOME);
    const greeted = withWelcome(HUB, "Ledger", "Watch the bill.");
    const next = withDeskWelcome(greeted);
    expect(next.startsWith("Greet them as Ledger, ")).toBe(true);
    expect(next).toContain("## Time-Based Greeting Rules");
    expect(next).not.toContain("Read your IDENTITY.md");
  });

  it("leaves one the person wrote", () => {
    const mine = "Say hi in French.\n";
    expect(isHubWelcome(mine)).toBe(false);
    expect(withDeskWelcome(mine)).toBe(mine);
    expect(withDeskWelcome(DESK_WELCOME)).toBe(DESK_WELCOME);
  });

  it("is written only for agents still on the hub's", async () => {
    const files: Record<string, string> = { scout: HUB, ledger: "Say hi in French.\n" };
    const hub = {
      identityFile: vi.fn(async (id: string) => files[id] ?? ""),
      saveIdentityFile: vi.fn(async (id: string, _f: string, t: string) => void (files[id] = t)),
    } as unknown as DeskHub;
    await adoptDeskWelcome(hub, ["scout", "ledger"]);
    expect(files.scout).toBe(DESK_WELCOME);
    expect(files.ledger).toBe("Say hi in French.\n");
    expect(hub.saveIdentityFile).toHaveBeenCalledTimes(1);
  });
});
