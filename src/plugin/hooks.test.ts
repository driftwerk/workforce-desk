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
        "PostToolUseFailure",
        "PermissionDenied",
        "UserPromptSubmit",
        "Notification",
        "PreCompact",
        "Stop",
        "StopFailure",
        "SubagentStart",
        "SubagentStop",
        "SessionEnd",
      ].sort(),
    );
    for (const [event, entries] of Object.entries(events)) {
      expect(entries[0]?.hooks[0]?.args[0], event).toBe("${CLAUDE_PLUGIN_ROOT}/hooks/desk-hook.sh");
    }
  });

  it("tells the hub of a turn an API error ended, which fires StopFailure and never Stop", () => {
    // Claude Code 2.1.319: a turn its plan's limit (or another API error)
    // ended fires StopFailure alone; without it the session stays working.
    const failed = events.StopFailure?.[0];
    expect(failed?.hooks[0]?.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/hooks/desk-hook.sh", "10"]);
    expect(failed?.hooks[0]?.timeout).toBe(10);
  });

  it("tells the hub before Claude Code compacts, so what was said is kept first, and never holds the compaction up", () => {
    // The hub answers at once and reads the record; 5 s at most either way.
    const compact = events.PreCompact?.[0];
    expect(compact?.matcher).toBeUndefined();
    expect(compact?.hooks[0]?.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/hooks/desk-hook.sh", "5"]);
    expect(compact?.hooks[0]?.timeout).toBe(5);
  });

  it("tells the hub of every tool auto mode refused, so a turn stuck on one isn't done", () => {
    const denied = events.PermissionDenied?.[0];
    expect(denied?.matcher).toBe("*");
    expect(denied?.hooks[0]?.timeout).toBe(10);
  });
});
