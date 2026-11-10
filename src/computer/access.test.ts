import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { addFolder, askingOf, grantText, levelLabel, levelOf, outcomeOf, withLevel, withWorksIn, worksInOf } from "./access";
import type { ComputerActivityRow } from "../hub/client";

describe("an agent's level on this computer", () => {
  it("reads Full access, asking first, from a file that says nothing", () => {
    expect(levelOf("")).toBe("full");
    expect(levelOf('[llm]\nprovider = "x"\n')).toBe("full");
    expect(levelOf("not toml [")).toBe("full");
    expect(levelOf('[computer]\naccess = "read_anywhere"\n')).toBe("read_anywhere");
    expect(levelLabel("full")).toBe("Full access · asks before irreversible things");
    expect(levelLabel("full", "never")).toBe("Full access · does anything");
    expect(askingOf("")).toBe("irreversible");
    expect(askingOf('[computer]\nasks = "never"\n')).toBe("never");
  });

  it("writes its level and keeps everything else; below Full, never on its own", () => {
    const out = parse(withLevel('[llm]\nprovider = "x"\n[computer]\naccess = "full"\nautonomous = true\nask_in_own_folder = true\n', "own_folder")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(out.llm).toEqual({ provider: "x" });
    expect(out.computer).toEqual({ access: "own_folder", ask_in_own_folder: true });
    expect(levelOf(withLevel("", "read_anywhere"))).toBe("read_anywhere");
    expect(parse(withLevel("", "full", "never"))).toEqual({ computer: { access: "full", asks: "never" } });
    expect(parse(withLevel('[computer]\nasks = "never"\n', "own_folder"))).toEqual({ computer: { access: "own_folder" } });
  });
});

describe("what's shown of grants and activity", () => {
  const row = (outcome: ComputerActivityRow["outcome"]["outcome"], decided_by: ComputerActivityRow["decided_by"] = "rule", reason: string | null = null): ComputerActivityRow => ({
    id: "a",
    at: new Date().toISOString(),
    agent: "allan",
    kind: "exec",
    doing: "run `npm test`",
    folder: null,
    tool: "exec.run",
    decided_by,
    outcome: { outcome },
    reason,
  });

  it("chips each outcome in plain words", () => {
    expect(outcomeOf(row("ran"))).toEqual({ text: "Ran", tone: "done" });
    expect(outcomeOf(row("ran", "grant"))).toEqual({ text: "Always allowed", tone: "done" });
    expect(outcomeOf(row("allowed", "person")).text).toBe("You allowed");
    expect(outcomeOf(row("declined", "person")).text).toBe("Declined");
    expect(outcomeOf(row("not_answered", "person")).text).toBe("Not answered");
    expect(outcomeOf(row("refused", "rule", "outside Allan's folder"))).toEqual({ text: "Refused: outside Allan's folder", tone: "blocked" });
  });

  it("says what a grant allows", () => {
    const g = { id: "g", agent: "allan", ability: "run" as const, folder: "~/dev/acme-web", connector: null, session_id: null, run_name: null, expires_at: null, created_at: "" };
    expect(grantText(g)).toBe("run commands in ~/dev/acme-web");
    expect(grantText({ ...g, ability: "connector_write", folder: null, connector: "linear" })).toBe("write to linear");
  });
});

describe("the folders an agent works in", () => {
  it("reads them, and nothing from a file without them or one with a mistake", () => {
    expect(worksInOf("")).toEqual([]);
    expect(worksInOf("not toml [")).toEqual([]);
    expect(worksInOf('[computer]\nworks_in = ["/Users/me/dev/acme", 3]\n')).toEqual(["/Users/me/dev/acme"]);
  });

  it("writes them beside its level and everything else, and drops the key when none are left", () => {
    const source = '[llm]\nprovider = "x"\n[computer]\naccess = "own_folder"\n';
    const two = withWorksIn(source, ["/Users/me/dev/acme", "/Users/me/dev/api"]);
    expect(parse(two)).toEqual({ llm: { provider: "x" }, computer: { access: "own_folder", works_in: ["/Users/me/dev/acme", "/Users/me/dev/api"] } });
    expect(levelOf(two)).toBe("own_folder");
    expect(parse(withWorksIn(two, []))).toEqual({ llm: { provider: "x" }, computer: { access: "own_folder" } });
    expect(parse(withWorksIn("", []))).toEqual({});
    // Changing the level keeps the folders.
    expect(worksInOf(withLevel(two, "full"))).toEqual(["/Users/me/dev/acme", "/Users/me/dev/api"]);
  });

  it("adds a folder once, and never home or above it", () => {
    expect(addFolder([], "/Users/me/dev/acme/", "/Users/me")).toEqual({ folders: ["/Users/me/dev/acme"], problem: null });
    expect(addFolder(["/Users/me/dev/acme"], "/Users/me/dev/acme", "/Users/me").folders).toEqual(["/Users/me/dev/acme"]);
    for (const wide of ["/", "/Users", "/Users/me", "/Users/me/"]) {
      expect(addFolder([], wide, "/Users/me").problem).toMatch(/inside your home/);
    }
  });
});
