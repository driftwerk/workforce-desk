import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { allowWrites, asksOf, bindingOf, choose, throughOf, withBinding } from "./connectors";

const TODAY = { reaching: ["github", "jira", "linear", "xero"], own: [] as string[] };

describe("an agent's connectors", () => {
  it("reads no [skills] as every connector, through my connection", () => {
    const b = bindingOf("[llm]\nprovider = \"anthropic\"\n");
    expect(b).toEqual({ enabled: null, readOnly: [], own: [] });
    expect(throughOf(b, "linear")).toBe("mine");
  });

  it("reads an empty enabled as none, and each connector's way in", () => {
    expect(throughOf(bindingOf("[skills]\nenabled = []\n"), "linear")).toBe("off");
    const b = bindingOf('[skills]\nenabled = ["linear", "github"]\nown_credential = ["linear"]\nread_only = ["github"]\n');
    expect(throughOf(b, "linear")).toBe("own");
    expect(throughOf(b, "github")).toBe("mine");
    expect(throughOf(b, "jira")).toBe("off");
  });

  it("keeps every connector an unchosen agent had when the first is turned off", () => {
    const b = choose(bindingOf(""), "jira", "off", TODAY);
    expect(b.enabled).toEqual(["github", "linear", "xero"]);
    // One it reached through its own connection still does.
    expect(choose(bindingOf(""), "jira", "off", { ...TODAY, own: ["linear"] }).own).toEqual(["linear"]);
  });

  it("writes the segments as the grammar says, leaving the rest of the file", () => {
    const source = '[llm]\nprovider = "anthropic"\n\n[skills]\nenabled = []\n';
    let b = choose(bindingOf(source), "linear", "own", TODAY);
    b = choose(b, "github", "mine", TODAY);
    b = allowWrites(b, "github", false, TODAY);
    const out = parse(withBinding(source, b)) as Record<string, Record<string, unknown>>;
    expect(out.llm).toEqual({ provider: "anthropic" });
    expect(out.skills).toEqual({ enabled: ["github", "linear"], read_only: ["github"], own_credential: ["linear"] });

    // Off again drops it from all three.
    const off = choose(choose(b, "github", "off", TODAY), "linear", "mine", TODAY);
    expect(parse(withBinding(source, off)).skills).toEqual({ enabled: ["linear"] });
  });

  it("reads whether the agent asks before what can't be undone", () => {
    expect(asksOf("")).toBe("irreversible");
    expect(asksOf('[computer]\naccess = "full"\nasks = "never"\n')).toBe("never");
  });
});
