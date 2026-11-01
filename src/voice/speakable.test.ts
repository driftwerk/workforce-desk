import { describe, expect, it } from "vitest";
import { speakable } from "./speakable";

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

  it("never reads code blocks aloud, and says where they are", () => {
    expect(speakable("Here's the fix:\n\n```rust\nfn main() {}\n```\n\nIt compiles.")).toBe(
      "Here's the fix: It compiles. The code is in the chat.",
    );
    expect(speakable("```\nonly code\n```")).toBe("The code is in the chat.");
    expect(speakable("Unclosed:\n```\nlet x = 1;")).toBe("Unclosed: The code is in the chat.");
  });

  it("says where only if the reply hasn't", () => {
    expect(speakable("The fix is in the chat.\n\n```\nfn main() {}\n```")).toBe("The fix is in the chat.");
    expect(speakable("It's on your screen:\n\n```\nfn main() {}\n```")).toBe("It's on your screen:");
    expect(speakable("We talked in the chat about it.")).toBe("We talked in the chat about it.");
  });

  it("leaves long inline code and tables on screen", () => {
    expect(speakable("Run `cargo test -p desk-voice --test pipeline -- --ignored` again")).toBe("Run again. The code is in the chat.");
    expect(speakable("Results:\n\n| test | status |\n|---|---|\n| auth | red |")).toBe("Results: The table is in the chat.");
    expect(speakable("Run this:\n```\nx\n```\n\n| a |\n|---|")).toBe("Run this: The rest is in the chat.");
  });

  it("says the whole of a long answer, however long", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    expect(speakable(long)).toBe(long);
    expect(speakable(long)).not.toContain("chat");
  });

  it("reads a short list and leaves a long one on screen", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `- item ${i}`).join("\n");
    expect(speakable(`Three:\n${list(3)}`)).toBe("Three: item 0. item 1. item 2.");
    expect(speakable(`All of them:\n${list(8)}\n\nThat's it.`)).toContain("item 7.");
    expect(speakable(`All of them:\n${list(9)}\n\nThat's it.`)).toBe("All of them: That's it. The full list is in the chat.");
    expect(speakable(`1. a\n   more of a\n\n${list(9)}\n\nEnd.`)).toBe("End. The full list is in the chat.");
  });

  it("leaves voice directions for the voice", () => {
    expect(speakable("(excited) **Found** it. [whispering] Over here (laughing).")).toBe("(excited) Found it. [whispering] Over here (laughing).");
  });

  it("drops html, images, rules and emoji", () => {
    expect(speakable("Done ✅\n\n---\n\n![chart](a.png)<br>All green.")).toBe("Done. All green.");
  });
});
