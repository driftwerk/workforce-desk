import { afterEach, describe, expect, it } from "vitest";
import { boxOf } from "./SessionCard";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("boxOf", () => {
  it("passes over holders laid out as display: contents, which are never on screen", () => {
    document.body.innerHTML = `<div id="card"><div id="view" style="display: contents"><span id="seen"></span></div></div>`;
    const seen = document.getElementById("seen")!;
    expect(boxOf(seen.parentElement)).toBe(document.getElementById("card"));
  });

  it("keeps a holder that draws its own box", () => {
    document.body.innerHTML = `<div id="card"><span id="seen"></span></div>`;
    expect(boxOf(document.getElementById("seen")!.parentElement)).toBe(document.getElementById("card"));
  });

  it("is nothing for nothing", () => {
    expect(boxOf(null)).toBeNull();
  });
});
