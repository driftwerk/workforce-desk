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

  it("says a message waits behind one on its way in, or as the answer its call waits on", () => {
    const session = lined({ name: "acme-web" });
    const at = new Date().toISOString();
    const waiting = (waiting: "behind" | "awaited") =>
      whyWaiting(msg({ from: DESK, to: S1, kind: "tell", asked: null, delivery: "queued", deliveredAt: null, at, waiting }), session, Date.parse(at));
    expect(waiting("behind")).toBe(
      "An earlier message is on its way into acme-web and hasn't been said to be there yet: this goes in after it, in the order they were sent.",
    );
    expect(waiting("awaited")).toBe("acme-web's call waits on this answer: it takes it as the call's result.");
  });
});
