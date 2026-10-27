import { describe, expect, it } from "vitest";
import { DETAILS_IN_DESK, speakable } from "./speakable";

describe("speakable", () => {
  it("keeps plain answers as they are", () => {
    expect(speakable("Two tests failed overnight.")).toBe("Two tests failed overnight.");
  });

  it("drops formatting and reads links as their text", () => {
    expect(speakable("## Overnight\n\nThe **nightly** build _failed_ — see [TASK-101](https://linear.app/x/TASK-101).")).toBe(
      "Overnight. The nightly build failed — see TASK-101.",
    );
    expect(speakable("Logs are at https://ci.example.com/run/42 now")).toBe("Logs are at a link now");
    expect(speakable("Use snake_case_names here")).toBe("Use snake_case_names here");
  });

  it("reads lists as sentences", () => {
    expect(speakable("Failures:\n- auth suite\n- `flaky_login` test\n1. rerun")).toBe("Failures: auth suite. flaky_login test. rerun.");
  });

  it("never reads code blocks aloud", () => {
    expect(speakable("Here's the fix:\n\n```rust\nfn main() {}\n```\n\nIt compiles.")).toBe(
      `Here's the fix: It compiles. ${DETAILS_IN_DESK}`,
    );
    expect(speakable("```\nonly code\n```")).toBe(DETAILS_IN_DESK);
    expect(speakable("Unclosed:\n```\nlet x = 1;")).toBe(`Unclosed: ${DETAILS_IN_DESK}`);
  });

  it("leaves long inline code and tables on screen", () => {
    expect(speakable("Run `cargo test -p desk-voice --test pipeline -- --ignored` again")).toBe(`Run again. ${DETAILS_IN_DESK}`);
    expect(speakable("Results:\n\n| test | status |\n|---|---|\n| auth | red |")).toBe(`Results: ${DETAILS_IN_DESK}`);
  });

  it("cuts long answers at a sentence", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const out = speakable(long, 120);
    expect(out.endsWith(DETAILS_IN_DESK)).toBe(true);
    expect(out.length).toBeLessThan(120 + DETAILS_IN_DESK.length + 2);
    expect(out.startsWith("Sentence number 0 is here. Sentence number 1 is here.")).toBe(true);
  });

  it("drops html, images, rules and emoji", () => {
    expect(speakable("Done ✅\n\n---\n\n![chart](a.png)<br>All green.")).toBe("Done. All green.");
  });
});
