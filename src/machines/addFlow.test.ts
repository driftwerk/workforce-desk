import { describe, expect, it } from "vitest";
import { setUp, setupFailed, START, step, type Flow, type FlowEvent } from "./addFlow";
import { probeOf } from "./testing";

const run = (events: FlowEvent[], from: Flow = START): Flow => events.reduce(step, from);
const typed = (target: string): FlowEvent[] => [{ type: "edit", target }, { type: "submit" }];

describe("adding a machine", () => {
  it("checks the address before asking the native side, and says what's wrong", () => {
    expect(run(typed(""))).toMatchObject({ at: "address", problem: "Type the machine’s address." });
    expect(run(typed("-oProxyCommand=evil"))).toMatchObject({ at: "address", problem: "An address can’t start with a dash." });
    expect(run(typed("dev box"))).toMatchObject({ at: "address", problem: "An address has no spaces in it." });
    expect(run(typed("dev\u0007box"))).toMatchObject({ at: "address", problem: "An address has no spaces in it." });
    expect(run(typed("x".repeat(256)))).toMatchObject({ at: "address", problem: "That address is too long." });
    expect(run(typed("  dev@203.0.113.7 "))).toEqual({ at: "checking", target: "dev@203.0.113.7" });
  });

  it("goes straight to setting up a known machine whose key gets in", () => {
    const f = run([...typed("devbox"), { type: "probed", probe: probeOf() }]);
    expect(f).toMatchObject({
      at: "setup",
      name: "devbox",
      machine: null,
      steps: { connect: { state: "done", detail: "Connected as dev · Ubuntu 24.04 · x86_64" }, install: { state: "waiting" } },
    });
  });

  it("shows a new machine's fingerprint, and looks again once it's trusted", () => {
    const probe = probeOf({ hostKey: { kind: "new", fingerprint: "SHA256:k3Vq9fXc", keyType: "ED25519" }, access: null });
    const asked = run([...typed("devbox"), { type: "probed", probe }]);
    expect(asked).toMatchObject({ at: "trust", fingerprint: "SHA256:k3Vq9fXc", keyType: "ED25519" });
    expect(step(asked, { type: "trust" })).toEqual({ at: "trusting", target: "devbox", fingerprint: "SHA256:k3Vq9fXc" });
    expect(run([{ type: "trust" }, { type: "trusted" }], asked)).toEqual({ at: "checking", target: "devbox" });
    // Cancel goes back to the address, as typed.
    expect(step(asked, { type: "back" })).toEqual({ at: "address", target: "devbox", problem: null });
  });

  it("refuses a changed host key: nothing trusts it from there", () => {
    const probe = probeOf({ hostKey: { kind: "changed", fingerprint: "SHA256:other", keyType: "ED25519" }, access: null });
    const f = run([...typed("devbox"), { type: "probed", probe }]);
    expect(f).toMatchObject({ at: "changed", fingerprint: "SHA256:other" });
    expect(step(f, { type: "trust" })).toBe(f);
    expect(step(f, { type: "trusted" })).toBe(f);
  });

  it("helps put this computer's key there when it's refused, and tries again", () => {
    const f = run([...typed("dev@203.0.113.7"), { type: "probed", probe: probeOf({ name: "203.0.113.7", access: { kind: "refused", user: "dev" } }) }]);
    expect(f).toMatchObject({ at: "key", why: "refused", user: "dev", name: "203.0.113.7" });
    expect(step(f, { type: "retry" })).toEqual({ at: "checking", target: "dev@203.0.113.7" });
    const locked = run([...typed("devbox"), { type: "probed", probe: probeOf({ access: { kind: "locked" } }) }]);
    expect(locked).toMatchObject({ at: "key", why: "locked" });
  });

  it("says why it can't reach one, back at the address", () => {
    const f = run([...typed("devbox"), { type: "probed", probe: probeOf({ access: { kind: "unreachable", message: "Desk can’t reach devbox: no route to it." } }) }]);
    expect(f).toEqual({ at: "address", target: "devbox", problem: "Desk can’t reach devbox: no route to it.", refused: true });
    expect(run([...typed("devbox"), { type: "failed", message: "ssh isn’t there" }])).toEqual({ at: "address", target: "devbox", problem: "ssh isn’t there", refused: true });
    // Typing again clears it.
    expect(step(f, { type: "edit", target: "dev@devbox" })).toEqual({ at: "address", target: "dev@devbox", problem: null });
  });

  it("ticks the checklist off from the machine's setup events, and only that machine's", () => {
    let f = run([...typed("devbox"), { type: "probed", probe: probeOf() }, { type: "added", machine: "devbox" }]);
    f = step(f, { type: "setup", event: { machine: "other", step: "install", state: "done" } });
    expect(f).toMatchObject({ steps: { install: { state: "waiting" } } });
    f = run(
      [
        { type: "setup", event: { machine: "devbox", step: "install", state: "running" } },
        { type: "setup", event: { machine: "devbox", step: "install", state: "blocked", message: "Linger is off", line: "sudo loginctl enable-linger dev" } },
      ],
      f,
    );
    expect(f).toMatchObject({ steps: { install: { state: "blocked", line: "sudo loginctl enable-linger dev" } } });
    expect(setUp(f)).toBe(false);
    // Waiting on linger, Desk is still installed: once the engines are in, it's set up.
    expect(setUp(step(f, { type: "setup", event: { machine: "devbox", step: "engines", state: "done" } }))).toBe(true);
    f = run(
      [
        { type: "setup", event: { machine: "devbox", step: "install", state: "done", detail: "Desk 0.2.0 installed, and set to start when it boots" } },
        { type: "setup", event: { machine: "devbox", step: "engines", state: "done" } },
      ],
      f,
    );
    expect(setUp(f)).toBe(true);
    expect(step(f, { type: "signedIn", engine: "claude" })).toMatchObject({ signedIn: { claude: true, codex: false } });
    // Once added, a failure is a step's, not a way back.
    expect(step(f, { type: "failed", message: "x" })).toBe(f);
  });

  it("says which step failed", () => {
    const f = run([
      ...typed("devbox"),
      { type: "probed", probe: probeOf() },
      { type: "added", machine: "devbox" },
      { type: "setup", event: { machine: "devbox", step: "engines", state: "failed", message: "npm isn’t on devbox" } },
    ]);
    expect(setupFailed(f)).toMatchObject({ message: "npm isn’t on devbox" });
  });
});
