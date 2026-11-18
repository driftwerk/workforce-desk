import { describe, expect, it } from "vitest";
import filesRs from "../../src-tauri/src/files.rs?raw";
import { BUILTIN, NIGHT } from "./builtin";
import { allChecks, freeId, parsePropose, parseProposal, parseRevise, propose, RESERVED_IDS, revise, serializeProposal } from "./proposal";
import { derive, isDarkGround, TOKENS } from "./tokens";

const low = (spec: Parameters<typeof derive>[0]) => allChecks(derive(spec)).filter((c) => !c.pass).map((c) => `${c.label} ${c.ratio.toFixed(2)}`);

describe("an agent's proposal", () => {
  it("is every colour worked out from three, and reads", () => {
    const { spec, changes } = propose(parsePropose({ name: "Moss", dark: true, background: "#13201A", signal: "#9BE38A" }), NIGHT, []);
    expect(spec.id).toBe("moss");
    expect(Object.keys(derive(spec).colors).sort()).toEqual([...TOKENS].sort());
    expect(low(spec)).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("moves what reads too faintly, and says what it moved", () => {
    // Grey text on a mid-dark ground, and a signal too dark to read on it.
    const { spec, changes } = propose(
      parsePropose({ name: "Murk", dark: true, background: "#2A2A2A", signal: "#3355AA", text: "#8A8A8A", colors: { ansiRed: "#550000" } }),
      NIGHT,
      [],
    );
    expect(low(spec)).toEqual([]);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.join(" ")).toMatch(/Terminal red read/);
    expect(changes.every((c) => c.includes("→"))).toBe(true);
    // One sentence a colour.
    expect(new Set(changes).size).toBe(changes.length);
    expect(changes.length).toBeLessThan(12);
  });

  it("is dark or light as the agent said", () => {
    const { spec, changes } = propose(parsePropose({ name: "Dusk", dark: true, background: "#8899AA", signal: "#FFCC66" }), NIGHT, []);
    expect(isDarkGround(spec.background)).toBe(true);
    expect(changes[0]).toMatch(/too light for a dark theme/);
    expect(low(spec)).toEqual([]);
    const light = propose(parsePropose({ name: "Sand", dark: false, background: "#3A3020", signal: "#1F5FBF" }), NIGHT, []);
    expect(isDarkGround(light.spec.background)).toBe(false);
    expect(low(light.spec)).toEqual([]);
  });

  it("reads for any colours at all", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const hex = () => `#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;
    for (let i = 0; i < 60; i++) {
      const { spec } = propose(parsePropose({ name: `T${i}`, dark: rnd() > 0.5, background: hex(), signal: hex(), text: rnd() > 0.5 ? hex() : undefined }), NIGHT, []);
      expect(low(spec), `${spec.background} ${spec.signal} ${spec.text}`).toEqual([]);
    }
  });

  it("takes the fonts and shape of the theme it starts from", () => {
    const { spec } = propose(parsePropose({ name: "Moss", dark: true, background: "#13201A", signal: "#9BE38A", corners: "round" }), NIGHT, []);
    expect(spec.fonts).toEqual(NIGHT.fonts);
    expect(spec.corners).toBe("round");
    expect(spec.density).toBe(NIGHT.density);
  });
});

describe("what an agent gives is checked", () => {
  const ok = { name: "Moss", dark: true, background: "#13201A", signal: "#9BE38A" };
  it.each([
    [{ ...ok, background: "red" }, /background/],
    [{ ...ok, signal: "#12345" }, /signal/],
    [{ ...ok, dark: "yes" }, /dark/],
    [{ ...ok, name: "" }, /name/],
    [{ ...ok, name: "x".repeat(49) }, /48/],
    [{ ...ok, colors: { glow: "#112233" } }, /no colour called "glow"/],
    [{ ...ok, colors: { muted: "#11223344" } }, /colors.muted/],
    [{ ...ok, colors: { bg: "#112233" } }, /background/],
    [{ ...ok, density: "roomy" }, /density/],
  ])("refuses %j", (input, error) => {
    expect(() => parsePropose(input)).toThrow(error);
  });

  it("takes alpha only where a colour does", () => {
    expect(parsePropose({ ...ok, colors: { shadow: "#00000059" } }).colors).toEqual({ shadow: "#00000059" });
  });

  it("runs a name's spaces and line breaks together", () => {
    expect(parsePropose({ ...ok, name: "  Deep\n\tsea  " }).name).toBe("Deep sea");
  });
});

describe("ids", () => {
  it("are never a built-in's, nor another theme's", () => {
    for (const b of BUILTIN) expect(freeId(b.name, [])).not.toBe(b.id);
    expect(freeId("Auto", [])).toBe("auto");
    expect(freeId("System", [])).toBe("system-2");
    expect(freeId("Moss", ["moss", "moss-2"])).toBe("moss-3");
    expect(freeId("../../etc", [])).toBe("etc");
    expect(freeId("!!!", [])).toBe("theme");
  });

  it("Desk's native side refuses the same ones", () => {
    const listed = /RESERVED_THEME_IDS: \[&str; \d+\] = \[([^\]]*)\]/.exec(filesRs)?.[1];
    expect(listed?.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)).sort()).toEqual([...RESERVED_IDS].sort());
  });
});

describe("a revision", () => {
  const first = propose(parsePropose({ name: "Moss", dark: true, background: "#2A2A2A", signal: "#3355AA", text: "#8A8A8A" }), NIGHT, []);

  it("changes only what it names, and reads again", () => {
    const { spec } = revise(first.spec, parseRevise({ theme: "moss", signal: "#FFAA33" }), first.nudged);
    expect(spec.signal).toBe("#FFAA33");
    expect(spec.background).toBe(first.spec.background);
    expect(spec.name).toBe("Moss");
    expect(low(spec)).toEqual([]);
  });

  it("puts a colour back to Desk's with null", () => {
    const withRed = revise(first.spec, parseRevise({ theme: "moss", colors: { ansiRed: "#FF8877" } })).spec;
    expect(withRed.overrides.ansiRed).toBe("#FF8877");
    expect(revise(withRed, parseRevise({ theme: "moss", colors: { ansiRed: null } })).spec.overrides.ansiRed).toBeUndefined();
  });
});

it("a proposal's file round-trips, and isn't a theme the chooser lists", () => {
  const { spec, changes, nudged } = propose(parsePropose({ name: "Moss", dark: true, background: "#2A2A2A", signal: "#3355AA" }), NIGHT, []);
  const p = { spec, nudged, hub: "local", agent: "atlas", session: "s1", reason: "Something mossy", changes, at: "2026-11-18T10:00:00.000Z" };
  const back = parseProposal(spec.id, serializeProposal(p));
  expect(back).toEqual({ ...p, spec: { ...spec, text: spec.text } });
});
