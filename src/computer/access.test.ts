import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { addFolder, askingOf, choicesFor, grantText, levelFor, levelLabel, levelOf, outcomeOf, overridesFor, siteText, typedOverride, withLevel, withWorksIn, worksInOf } from "./access";
import type { OnItsOwnRow } from "../hub/client";
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
    expect(outcomeOf(row("ran", "on_its_own"))).toEqual({ text: "On its own", tone: "done" });
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

describe("what an agent does on its own", () => {
  const rows: OnItsOwnRow[] = [
    { kind: "commands", scope: { kind: "kind" }, level: "in_folders", created_at: "" },
    { kind: "network", scope: { kind: "host", value: "devbox" }, level: "anywhere", created_at: "" },
    { kind: "network", scope: { kind: "host", value: "10.0.1.20" }, level: "anywhere", created_at: "" },
  ];

  it("reads each kind's level and overrides", () => {
    expect(levelFor(rows, "commands")).toBe("in_folders");
    expect(levelFor(rows, "network")).toBeNull();
    expect(overridesFor(rows, "network")).toEqual(["devbox", "10.0.1.20"]);
    expect(overridesFor(rows, "commands")).toEqual([]);
    expect(choicesFor("host").map((c) => c.id)).toEqual([null, "anywhere"]);
    expect(choicesFor("folder").map((c) => c.id)).toEqual([null, "in_folders", "anywhere"]);
  });

  it("keeps a typed host or site as the hub does, and says why it can't", () => {
    expect(typedOverride("host", " dev@DevBox ")).toEqual({ value: "devbox", problem: null });
    expect(typedOverride("host", "::1").value).toBe("::1");
    expect(typedOverride("host", "a b").problem).toBe("a b isn’t a host name or address.");
    expect(typedOverride("host", "  ")).toEqual({ value: null, problem: null });
    expect(typedOverride("site", "GitHub.com/acme/web")).toEqual({ value: "https://github.com", problem: null });
    expect(typedOverride("site", "http://localhost:3000/x").value).toBe("http://localhost:3000");
    expect(typedOverride("site", "ftp://x.example").problem).toBe("ftp://x.example isn’t a website.");
    expect(siteText("https://github.com")).toBe("github.com");
    expect(siteText("http://localhost:3000")).toBe("http://localhost:3000");
  });
});
