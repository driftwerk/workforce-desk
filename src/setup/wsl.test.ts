import { describe, expect, it } from "vitest";
import type { WslFound } from "../platform";
import { firstPick, optionFor, problemText, stepsAfter } from "./wsl";

const probe = { arch: "x86_64", kernel: "6.6.36.6-microsoft-standard-WSL2", user: "sarah", home: "/home/sarah", automount: "/mnt/", glibc: "2.39" };
const ubuntu: WslFound = { distro: { name: "Ubuntu-24.04", state: "Running", version: 2, default: true }, probe, problem: null };
const debian: WslFound = { distro: { name: "Debian", state: "Stopped", version: 2, default: false }, probe, problem: null };
const old: WslFound = {
  distro: { name: "Ubuntu-20.04", state: "Stopped", version: 1, default: false },
  probe: null,
  problem: { kind: "wsl1", distro: "Ubuntu-20.04" },
};
const rooted: WslFound = { ...debian, problem: { kind: "root_user", distro: "Debian" } };

describe("choosing a Linux", () => {
  it("says what each distro is, and how a WSL 1 one is fixed", () => {
    expect(optionFor(ubuntu)).toEqual({
      name: "Ubuntu-24.04",
      note: "WSL 2 · your default · Linux 6.6 · you’re sarah here",
      tag: "Recommended",
      usable: true,
      convert: false,
    });
    expect(optionFor(debian).note).toBe("WSL 2 · stopped · Linux 6.6 · you’re sarah here");
    expect(optionFor(old)).toMatchObject({ tag: "Convert to WSL 2", usable: true, convert: true });
    expect(optionFor(rooted)).toMatchObject({ usable: false, note: "Set a normal default user for Debian; Desk won’t run as root" });
  });

  it("picks the default first, then another that needs no change", () => {
    expect(firstPick([old, debian, ubuntu])).toBe("Ubuntu-24.04");
    expect(firstPick([old, debian])).toBe("Debian");
    expect(firstPick([old, rooted])).toBe("Ubuntu-20.04");
    expect(firstPick([rooted])).toBeNull();
  });

  it("words every problem without the hub's name", () => {
    expect(problemText({ kind: "old_linux", glibc: "2.31" })).toMatch(/22\.04/);
    expect(problemText({ kind: "not_installed" })).toBe("WSL isn’t on this computer yet");
  });
});

describe("setting Desk up", () => {
  it("follows each step's events, keeping a note once given", () => {
    const after = stepsAfter([
      { step: "copy", state: "running", note: null },
      { step: "copy", state: "done", note: null },
      { step: "check", state: "done", note: "Linux 6.6 · glibc 2.39 · x86_64 · home on ext4" },
      { step: "reach", state: "blocked", note: "[wsl2]\nlocalhostForwarding=true" },
    ]);
    expect(after.copy.state).toBe("done");
    expect(after.check).toEqual({ state: "done", note: "Linux 6.6 · glibc 2.39 · x86_64 · home on ext4" });
    expect(after.start.state).toBe("waiting");
    expect(after.reach.state).toBe("blocked");
  });
});
