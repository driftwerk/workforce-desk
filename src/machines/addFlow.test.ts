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
    // No name typed: the address's host.
    expect(run(typed("  dev@203.0.113.7 "))).toEqual({ at: "checking", target: "dev@203.0.113.7", name: "203.0.113.7" });
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
    expect(step(asked, { type: "trust" })).toEqual({ at: "trusting", target: "devbox", name: "devbox", fingerprint: "SHA256:k3Vq9fXc" });
    expect(run([{ type: "trust" }, { type: "trusted" }], asked)).toEqual({ at: "checking", target: "devbox", name: "devbox" });
    // Cancel goes back to the address, as typed, its name kept.
    expect(step(asked, { type: "back" })).toEqual({ at: "address", target: "devbox", name: "devbox", named: true, problem: null });
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
    expect(step(f, { type: "retry" })).toEqual({ at: "checking", target: "dev@203.0.113.7", name: "203.0.113.7" });
    const locked = run([...typed("devbox"), { type: "probed", probe: probeOf({ access: { kind: "locked" } }) }]);
    expect(locked).toMatchObject({ at: "key", why: "locked" });
  });

  it("says why it can't reach one, back at the address", () => {
    const f = run([...typed("devbox"), { type: "probed", probe: probeOf({ access: { kind: "unreachable", message: "Desk can’t reach devbox: no route to it." } }) }]);
    expect(f).toEqual({ at: "address", target: "devbox", name: "devbox", named: true, problem: "Desk can’t reach devbox: no route to it.", refused: true });
    expect(run([...typed("devbox"), { type: "failed", message: "ssh isn’t there" }])).toEqual({
      at: "address",
      target: "devbox",
      name: "devbox",
      named: true,
      problem: "ssh isn’t there",
      refused: true,
    });
    // Typing again clears it.
    expect(step(f, { type: "edit", target: "dev@devbox" })).toEqual({ at: "address", target: "dev@devbox", name: "devbox", named: true, problem: null, picked: null });
  });

  it("keeps the address the SSH config knows another spelling of, until typing again", () => {
    const f = run([...typed("Devbox"), { type: "probed", probe: probeOf({ access: { kind: "unreachable", message: "SSH couldn’t reach Devbox.", suggest: "devbox" } }) }]);
    expect(f).toEqual({ at: "address", target: "Devbox", name: "Devbox", named: true, problem: "SSH couldn’t reach Devbox.", refused: true, suggest: "devbox" });
    expect(step(f, { type: "edit", target: "devbox" })).toEqual({ at: "address", target: "devbox", name: "Devbox", named: true, problem: null, picked: null });
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

  it("names it after its address until the person types a name, and never as another machine", () => {
    let f = run([{ type: "pick", host: "devbox-gpu" }, { type: "name", name: "devbox-gpu", typed: false }]);
    expect(f).toMatchObject({ at: "address", target: "devbox-gpu", picked: "devbox-gpu", name: "devbox-gpu", named: false });
    f = run([{ type: "name", name: "GPU box", typed: true }, { type: "name", name: "devbox-gpu", typed: false }], f);
    expect(f).toMatchObject({ name: "GPU box", named: true });
    // Typing an address after picking one leaves the pick.
    expect(step(f, { type: "edit", target: "root@devbox" })).toMatchObject({ picked: null, target: "root@devbox", name: "GPU box" });
    expect(run([{ type: "submit", taken: ["gpu BOX"] }], f)).toMatchObject({ at: "address", problem: "Another machine is called GPU box already. Two machines can’t share a name." });
    expect(run([{ type: "submit", taken: ["devbox"] }], f)).toEqual({ at: "checking", target: "devbox-gpu", name: "GPU box" });
    expect(run([...typed("devbox"), { type: "probed", probe: probeOf({ name: "devbox" }) }], { ...START, name: "devbox (root)", named: true } as Flow)).toMatchObject({
      at: "setup",
      name: "devbox (root)",
    });
  });

  it("is cancelled once the native side says so, and set up again on Retry", () => {
    let f = run([...typed("devbox"), { type: "probed", probe: probeOf() }, { type: "added", machine: "devbox" }]);
    f = step(f, { type: "setup", event: { machine: "devbox", step: "install", state: "failed", message: "~ on devbox has 180 MB free, and Desk needs 420 MB." } });
    expect(step(f, { type: "retrying" })).toMatchObject({ steps: { connect: { state: "running" }, install: { state: "waiting" }, engines: { state: "waiting" } } });
    f = step(f, { type: "cancelling" });
    expect(f).toMatchObject({ cancelling: true });
    expect(step(f, { type: "setup", event: { machine: "devbox", step: "install", state: "failed", message: "Adding it was cancelled." } })).toMatchObject({ cancelled: true });
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
