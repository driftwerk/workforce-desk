import { describe, expect, it } from "vitest";
import { providerById } from "./voiceCatalog";

describe("Fish Audio in the voice catalogue", () => {
  const fish = providerById("fish_audio")!;

  it("starts on the free model, so a first try costs nothing", () => {
    expect(fish.models[0]?.id).toBe("s2.1-pro-free");
    expect(fish.models[0]?.name).toMatch(/free/);
  });

  it("marks every other model paid, the retiring S1 among them", () => {
    const others = fish.models.slice(1);
    expect(others.map((m) => m.id)).toEqual(["s2.1-pro", "s1"]);
    expect(others.every((m) => /paid/.test(m.name))).toBe(true);
    expect(fish.models.find((m) => m.id === "s1")!.note).toMatch(/31 December 2026/);
  });

  it("recommends distinct voices by their 32-hex ids", () => {
    const voices = fish.voices as { id: string }[];
    expect(voices.length).toBeGreaterThanOrEqual(8);
    expect(new Set(voices.map((v) => v.id)).size).toBe(voices.length);
    expect(voices.every((v) => /^[0-9a-f]{32}$/.test(v.id))).toBe(true);
    // The voice that Fish Audio no longer serves (404 on 2026-11-11) is gone.
    expect(voices.some((v) => v.id === "8ef4a238714b45718ce04243307c57a7")).toBe(false);
  });
});
