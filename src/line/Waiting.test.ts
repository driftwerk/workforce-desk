import { describe, expect, it } from "vitest";
import { whyWaiting } from "./Waiting";
import { DESK, lined, msg, S1 } from "./testing";

describe("why a message waits", () => {
  it("tells a dialog on its screen from a question its turn ended on", () => {
    const session = lined({ name: "acme-web" });
    const at = new Date().toISOString();
    const waiting = (waiting: "dialog" | "asking") =>
      whyWaiting(msg({ from: DESK, to: S1, kind: "tell", asked: null, delivery: "queued", deliveredAt: null, at, waiting }), session, Date.parse(at));
    expect(waiting("dialog")).toBe("acme-web waits on a dialog in its terminal: this goes in after it is answered and its turn ends.");
    expect(waiting("asking")).toBe("acme-web's turn ended asking you something: this goes in once you've answered it.");
  });
});
