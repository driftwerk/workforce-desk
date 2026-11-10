import { describe, expect, it } from "vitest";
import { TYPING_EVERY_MS, typingPinger } from "./typing";

describe("typing in a session's composer", () => {
  it("tells the hub at most every 20 seconds per session, and never for an empty draft", () => {
    let t = 0;
    const sent: string[] = [];
    const ping = typingPinger((id) => sent.push(id), TYPING_EVERY_MS, () => t);
    ping("s1", "   ");
    expect(sent).toEqual([]);
    ping("s1", "R");
    ping("s1", "Ru");
    t = 19_999;
    ping("s1", "Run");
    expect(sent).toEqual(["s1"]);
    ping("s2", "Hi");
    expect(sent).toEqual(["s1", "s2"]);
    t = 20_000;
    ping("s1", "Run the");
    expect(sent).toEqual(["s1", "s2", "s1"]);
  });
});
