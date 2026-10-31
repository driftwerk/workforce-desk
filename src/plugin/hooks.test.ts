import { describe, expect, it } from "vitest";
import hooks from "../../src-tauri/resources/claude-plugin/hooks/hooks.json";

type Entry = { matcher?: string; hooks: { type: string; command: string; args: string[]; timeout: number }[] };

const events = hooks.hooks as Record<string, Entry[]>;

describe("Desk's Claude Code plugin hooks", () => {
  it("passes every event the hub reads for a tracked session to it", () => {
    // The same events, in the same shape, as the hooks the hub gives the
    // sessions Desk starts.
    expect(Object.keys(events).sort()).toEqual(
      [
        "SessionStart",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "PermissionDenied",
        "UserPromptSubmit",
        "Notification",
        "Stop",
        "SubagentStart",
        "SubagentStop",
        "SessionEnd",
      ].sort(),
    );
    for (const [event, entries] of Object.entries(events)) {
      expect(entries[0]?.hooks[0]?.args[0], event).toBe("${CLAUDE_PLUGIN_ROOT}/hooks/desk-hook.sh");
    }
  });

  it("tells the hub of every tool auto mode refused, so a turn stuck on one isn't done", () => {
    const denied = events.PermissionDenied?.[0];
    expect(denied?.matcher).toBe("*");
    expect(denied?.hooks[0]?.timeout).toBe(10);
  });
});
