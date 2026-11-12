import { describe, expect, it } from "vitest";
import type { WslFound } from "../platform";
import { firstPick, offerAlongside, optionFor, problemText, stepsAfter } from "./wsl";

const probe = { arch: "x86_64", kernel: "6.6.36.6-microsoft-standard-WSL2", user: "sarah", home: "/home/sarah", automount: "/mnt/", glibc: "2.39" };
const ubuntu: WslFound = { distro: { name: "Ubuntu-24.04", state: "Running", version: 2, default: true }, probe, problem: null };
const debian: WslFound = { distro: { name: "Debian", state: "Stopped", version: 2, default: false }, probe, problem: null };
const old: WslFound = {
  distro: { name: "Ubuntu-20.04", state: "Stopped", version: 1, default: false },
  probe: null,
  problem: { kind: "wsl1", distro: "Ubuntu-20.04" },
};
const rooted: WslFound = { ...debian, problem: { kind: "root_user", distro: "Debian" } };
const ancient: WslFound = { distro: { name: "Ubuntu", state: "Stopped", version: 2, default: true }, probe: { ...probe, glibc: "2.31" }, problem: { kind: "old_linux", glibc: "2.31" } };

describe("choosing a Linux", () => {
  it("says what each distro is, and how a WSL 1 one is fixed", () => {
    expect(optionFor(ubuntu)).toEqual({
      name: "Ubuntu-24.04",
      note: "WSL 2 · your default · Linux 6.6 · you’re sarah here",
      tag: "Recommended",
      usable: true,
      convert: false,
      fix: null,
    });
    expect(optionFor(debian).note).toBe("WSL 2 · stopped · Linux 6.6 · you’re sarah here");
    expect(optionFor(old)).toMatchObject({ tag: "Convert to WSL 2", usable: true, convert: true, fix: "convert" });
    // Root only: Desk makes a user, with the person's yes.
    expect(optionFor(rooted)).toMatchObject({ tag: "Create a user", usable: true, fix: "user" });
    expect(optionFor(rooted).note).toContain("“Create a user” makes you one and sets it as the default; your files stay.");
    // Too old: not usable, and nothing of glibc in the words.
    expect(optionFor(ancient)).toMatchObject({ usable: false, tag: "Can’t use", fix: null });
    expect(optionFor(ancient).note).not.toMatch(/glibc/);
  });

  it("picks the default first, then another that needs no change", () => {
    expect(firstPick([old, debian, ubuntu])).toBe("Ubuntu-24.04");
    expect(firstPick([old, debian])).toBe("Debian");
    expect(firstPick([old, rooted])).toBe("Ubuntu-20.04");
    expect(firstPick([rooted])).toBe("Debian");
    expect(firstPick([ancient])).toBeNull();
  });

  it("words every problem without the hub's name", () => {
    expect(problemText({ kind: "old_linux", glibc: "2.31" })).toBe("Too old for Desk: it needs a newer Linux, such as Ubuntu 22.04 or later");
    expect(problemText({ kind: "not_installed" })).toBe("WSL isn’t on this computer yet");
  });
});

describe("a Linux too old for Desk", () => {
  it("offers Ubuntu alongside only when nothing else can be used", () => {
    expect(offerAlongside([ancient])).toBe(true);
    expect(offerAlongside([ancient, ubuntu])).toBe(false);
    expect(offerAlongside([ancient, rooted])).toBe(false);
    expect(offerAlongside([rooted])).toBe(false);
    // One Desk couldn't look into: unknown, so nothing to offer for it.
    expect(offerAlongside([ancient, { ...debian, probe: null, problem: null }])).toBe(false);
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

describe("what Desk doesn't need to ask", () => {
  it("sets up without asking only when one Linux on WSL 2 can be used", async () => {
    const { onlyChoice } = await import("./wsl");
    expect(onlyChoice([ubuntu])).toBe("Ubuntu-24.04");
    // One that Desk would fix first is a choice to make.
    expect(onlyChoice([ubuntu, rooted])).toBeNull();
    expect(onlyChoice([ubuntu, ancient])).toBe("Ubuntu-24.04");
    expect(onlyChoice([ubuntu, debian])).toBeNull();
    expect(onlyChoice([old])).toBeNull();
    expect(onlyChoice([])).toBeNull();
  });

  it("says why Set up can't be pressed", async () => {
    const { whyNotYet } = await import("./wsl");
    expect(whyNotYet(null, false)).toBe("Choose a Linux first.");
    expect(whyNotYet(optionFor(ancient), false)).toMatch(/^Desk can’t run in Ubuntu: Too old for Desk/);
    expect(whyNotYet(optionFor(rooted), false)).toBeNull();
    expect(whyNotYet(optionFor(ubuntu), false)).toBeNull();
  });
});
