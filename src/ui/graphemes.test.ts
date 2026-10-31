import { describe, expect, it } from "vitest";
import { clip, firstGrapheme, graphemes } from "./graphemes";
import { initialsFor } from "./Mark";

describe("text with emoji in it", () => {
  it("is cut between the characters a reader sees, never inside an emoji", () => {
    expect(graphemes("a👩🏽‍💻🇬🇧❤️")).toEqual(["a", "👩🏽‍💻", "🇬🇧", "❤️"]);
    expect(clip("ok 👨‍👩‍👧‍👦 then", 4)).toBe("ok 👨‍👩‍👧‍👦…");
    expect(clip("short", 80)).toBe("short");
    expect(clip("ab👍🏿", 2, "")).toBe("ab");
  });

  it("an agent named with an emoji has that emoji, whole, as its mark", () => {
    expect(firstGrapheme("👩🏽‍💻 Dev")).toBe("👩🏽‍💻");
    expect(initialsFor("👩🏽‍💻 Dev")).toBe("👩🏽‍💻");
    expect(initialsFor("🇬🇧 Desk")).toBe("🇬🇧");
    expect(initialsFor("scout")).toBe("S");
    expect(initialsFor("  ")).toBe("?");
  });
});
