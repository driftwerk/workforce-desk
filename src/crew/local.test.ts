import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import { HubError, type DeskHub } from "../hub/client";
import {
  agentId,
  instructions,
  purposeOf,
  RENAME_UNAVAILABLE,
  renameAgentFiles,
  renameLocalAgent,
  withJob,
  withName,
  withPurpose,
  withWelcome,
} from "./local";
import { withVoice } from "./voice";

describe("local crew", () => {
  it("makes a unique id from a name", () => {
    expect(agentId("Release Captain!", [])).toBe("release-captain");
    expect(agentId("Release Captain", ["release-captain", "release-captain-2"])).toBe("release-captain-3");
    expect(agentId("🙂", [])).toBe("agent");
  });

  it("keeps the person's words as the instructions", () => {
    expect(instructions("Scout", "  Watch CI and tell me when it breaks. ")).toContain("Watch CI and tell me when it breaks.");
  });

  it("puts what the agent is for at the top of its soul, once", () => {
    const soul = "# SOUL.md — Who You Are\n\n## Core Identity\n\nYou are an AI agent.\n\n## Boundaries\n\n- Private things stay private\n";
    const once = withPurpose(soul, "Scout", "Watch CI.\nTell me when it breaks.");
    expect(once.indexOf("## What You're For")).toBeLessThan(once.indexOf("## Core Identity"));
    expect(once).toContain("> Watch CI.\n> Tell me when it breaks.");
    expect(once).toContain("## Boundaries");
    const again = withPurpose(once, "Scout", "Watch deploys.");
    expect(again.match(/## What You're For/g)).toHaveLength(1);
    expect(again).toContain("> Watch deploys.");
    expect(again).not.toContain("Watch CI.");
  });

  it("gives the hub an agent's voice when the hub can speak with it", () => {
    const fish = parse(withVoice("[llm]\nprovider = \"chatgpt\"\n", { provider: "fish_audio", voice: "abc" })) as Record<string, Record<string, unknown>>;
    expect(fish.llm).toEqual({ provider: "chatgpt", speech: { provider: "fish_audio", voice: "abc" } });
    const local = parse(withVoice(withVoice("", { provider: "fish_audio", voice: "abc" }), { provider: "kokoro", voice: "af_heart" })) as Record<
      string,
      Record<string, unknown>
    >;
    expect(local.llm!.speech).toBeUndefined();
  });

  it("names the agent in its identity", () => {
    expect(withName("- **Name:** \n- **Vibe:** \n", "Scout")).toBe("- **Name:** Scout\n- **Vibe:** \n");
  });

  it("reads what the agent is for back from its soul", () => {
    const soul = withPurpose("# SOUL.md\n\n## Core Identity\n\nYou are an AI agent.\n", "Scout", "Watch CI.\nTell me when it breaks.");
    expect(purposeOf(soul)).toBe("Watch CI.\nTell me when it breaks.");
    expect(purposeOf("# SOUL.md\n\n## Core Identity\n")).toBe("");
  });

  it("puts the agent's job first in its working rules, keeping the hub's guidelines", () => {
    const agents = "# Operational Guidelines\n\n## Every Session\n\n1. Read SOUL.md\n";
    const once = withJob(agents, "Ledger", "Watch the AWS bill.");
    expect(once.indexOf("## Your Job")).toBeLessThan(once.indexOf("## Every Session"));
    expect(once).toContain("> Watch the AWS bill.");
    const again = withJob(once, "Ledger", "Watch the GCP bill.");
    expect(again.match(/## Your Job/g)).toHaveLength(1);
    expect(again).not.toContain("AWS");
    expect(withJob("", "Ledger", "Watch the bill.")).toMatch(/^## Your Job\n/);
  });

  it("opens its welcome by saying who it is, once", () => {
    const welcome = "Read your IDENTITY.md and SOUL.md to know who you are.\nKeep it to 2-3 sentences.\n";
    const once = withWelcome(welcome, "Ledger", "Watch the\nAWS bill.");
    expect(once.startsWith("Greet them as Ledger, and say in one sentence what you're here for: Watch the AWS bill.\n")).toBe(true);
    expect(once).toContain("Keep it to 2-3 sentences.");
    const again = withWelcome(once, "Ledger", "Watch deploys.");
    expect(again.match(/Greet them as/g)).toHaveLength(1);
    expect(again).toContain("Watch deploys.");
  });
});

/** A hub keeping identity files in memory. */
const filesHub = (files: Record<string, string>, rename: () => Promise<unknown> = () => Promise.resolve({})) => {
  const hub = {
    renameAgent: vi.fn(rename),
    identityFile: vi.fn(async (_id: string, f: string) => files[f] ?? ""),
    saveIdentityFile: vi.fn(async (_id: string, f: string, t: string) => void (files[f] = t)),
  };
  return hub as typeof hub & DeskHub;
};

describe("renaming an agent", () => {
  it("renames it, and puts the new name in its identity and the sections written from what it's for", async () => {
    const files: Record<string, string> = {
      "IDENTITY.md": "# Identity\n- **Name:** Ledger\n- **Vibe:** calm\n",
      "SOUL.md": withPurpose("# Soul\n", "Ledger", "Watch the bill."),
      "AGENTS.md": withJob("# Guidelines\n", "Ledger", "Watch the bill."),
      "WELCOME.md": withWelcome("Keep it short.\n", "Ledger", "Watch the bill."),
    };
    const hub = filesHub(files);
    await renameLocalAgent(hub, "ledger", "  Penny ");
    await renameAgentFiles(hub, "ledger", "  Penny ");
    expect(hub.renameAgent).toHaveBeenCalledWith("ledger", "Penny");
    expect(files["IDENTITY.md"]).toBe("# Identity\n- **Name:** Penny\n- **Vibe:** calm\n");
    expect(files["SOUL.md"]).toContain("You are Penny.");
    expect(files["SOUL.md"]).not.toContain("Ledger");
    expect(files["AGENTS.md"]).toContain("As Penny,");
    expect(files["WELCOME.md"]).toMatch(/^Greet them as Penny, .*Watch the bill\./);
    expect(purposeOf(files["SOUL.md"]!)).toBe("Watch the bill.");
  });

  it("writes a new purpose along with the new name", async () => {
    const files: Record<string, string> = { "SOUL.md": withPurpose("", "Ledger", "Watch the bill."), "AGENTS.md": "# G\n" };
    await renameAgentFiles(filesHub(files), "ledger", "Penny", "Watch deploys.");
    expect(purposeOf(files["SOUL.md"]!)).toBe("Watch deploys.");
    expect(files["SOUL.md"]).toContain("You are Penny.");
  });

  it("leaves the files alone and says so plainly when the hub can't rename yet", async () => {
    for (const status of [404, 405]) {
      const files: Record<string, string> = { "IDENTITY.md": "- **Name:** Ledger\n" };
      const hub = filesHub(files, () => Promise.reject(new HubError(status, "not found")));
      await expect(renameLocalAgent(hub, "ledger", "Penny")).rejects.toThrow(RENAME_UNAVAILABLE);
      expect(hub.saveIdentityFile).not.toHaveBeenCalled();
      expect(files["IDENTITY.md"]).toBe("- **Name:** Ledger\n");
    }
    expect(RENAME_UNAVAILABLE).not.toMatch(/hub|api|http|40\d/i);
  });
});
