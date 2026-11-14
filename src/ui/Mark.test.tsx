import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_MARK, markFor, MARK_TOKENS, SERIES_MARK_TOKENS, tokenVar } from "../theme/tokens";
import { initialsFor, Mark, markText } from "./Mark";

afterEach(cleanup);

const face = (el: HTMLElement) => el.querySelector<HTMLElement>(".mark-face")!;

describe("a mark's fill", () => {
  it("is a pastel mark, round for a person, by default", () => {
    const { container } = render(<Mark name="Richard Lucas" size="xs" person />);
    expect(face(container).style.background).toBe(tokenVar(markFor("Richard Lucas")));
    expect(face(container).style.color).toBe("");
    expect(face(container).textContent).toBe("R");
    expect(container.querySelector(".mark")!.className).toContain("mark-person");
  });

  it("is a series colour by name, with its ink, as a rounded square, on the board", () => {
    const { container } = render(<Mark name="Richard Lucas" size="xs" person tone="series" />);
    const token = markFor("Richard Lucas", SERIES_MARK_TOKENS);
    expect(SERIES_MARK_TOKENS).toContain(token);
    expect(face(container).style.background).toBe(tokenVar(token));
    expect(face(container).style.color).toBe("var(--on-series-mark)");
    expect(container.querySelector(".mark")!.className).not.toContain("mark-person");
    expect(face(container).textContent).toBe("RL");
  });

  it("is the first initial alone for the person themselves, coloured by their whole name", () => {
    const { container } = render(<Mark name="Kai Moreno" size="xs" person tone="series" you />);
    expect(face(container).textContent).toBe("K");
    expect(face(container).style.background).toBe(tokenVar(markFor("Kai Moreno", SERIES_MARK_TOKENS)));
  });

  it("keeps a person's picture round on the board", () => {
    const { container } = render(<Mark name="Ana Diaz" size="xs" person tone="series" src="data:image/png;base64,AA==" />);
    expect(container.querySelector(".mark")!.className).toContain("mark-person");
    expect(container.querySelector("img")).toBeTruthy();
  });

  it("spreads names over the same slots in both lists", () => {
    for (const name of ["Kingsley", "Matt", "Richard Lucas", "Pia", "atlas"])
      expect(SERIES_MARK_TOKENS.indexOf(markFor(name, SERIES_MARK_TOKENS) as never)).toBe(MARK_TOKENS.indexOf(markFor(name) as never));
  });
});

describe("an engine's mark", () => {
  it("is its own initials, on the one ground every engine has", () => {
    expect(["claude", "codex", "devin"].map((e) => initialsFor("brisk-otter", e))).toEqual(["cc", "cx", "dv"]);
    expect(initialsFor("brisk-otter", "gemini")).toBe("B");
    const { container } = render(<Mark name="brisk-otter" engine="devin" state="working" />);
    expect(face(container).textContent).toBe("dv");
    expect(face(container).style.background).toBe(tokenVar(ENGINE_MARK));
    expect(container.querySelector(".mark")!.className).toContain("ring-working");
  });
});

describe("the board's initials", () => {
  it("take whole graphemes, never half an emoji", () => {
    expect(markText("Richard Lucas", false)).toBe("RL");
    expect(markText("brisk-otter", true)).toBe("bo");
    expect(markText("🦊 Fox", false)).toBe("🦊F");
    expect(markText("𝒜da 👩‍💻", false)).toBe("𝒜👩‍💻");
    expect(markText("  ", false)).toBe("?");
  });
});
