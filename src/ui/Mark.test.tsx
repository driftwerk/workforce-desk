import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { markFor, MARK_TOKENS, SERIES_MARK_TOKENS, tokenVar } from "../theme/tokens";
import { Mark } from "./Mark";

afterEach(cleanup);

const face = (el: HTMLElement) => el.querySelector<HTMLElement>(".mark-face")!;

describe("a mark's fill", () => {
  it("is a pastel mark, round for a person, by default", () => {
    const { container } = render(<Mark name="Richard Lucas" size="xs" person />);
    expect(face(container).style.background).toBe(tokenVar(markFor("Richard Lucas")));
    expect(face(container).style.color).toBe("");
    expect(container.querySelector(".mark")!.className).toContain("mark-person");
  });

  it("is a series colour by name, with its ink, as a rounded square, on the board", () => {
    const { container } = render(<Mark name="Richard Lucas" size="xs" person tone="series" />);
    const token = markFor("Richard Lucas", SERIES_MARK_TOKENS);
    expect(SERIES_MARK_TOKENS).toContain(token);
    expect(face(container).style.background).toBe(tokenVar(token));
    expect(face(container).style.color).toBe("var(--on-series-mark)");
    expect(container.querySelector(".mark")!.className).not.toContain("mark-person");
    expect(face(container).textContent).toBe("R");
  });

  it("spreads names over the same slots in both lists", () => {
    for (const name of ["Kingsley", "Matt", "Richard Lucas", "Pia", "atlas"])
      expect(SERIES_MARK_TOKENS.indexOf(markFor(name, SERIES_MARK_TOKENS) as never)).toBe(MARK_TOKENS.indexOf(markFor(name) as never));
  });
});
